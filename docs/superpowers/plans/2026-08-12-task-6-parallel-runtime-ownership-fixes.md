# Task 6 Parallel Runtime Ownership Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Task 6 review blockers without restoring test serialization: break the observer worker ownership cycle, prove both callback permits survive caller cancellation, remove the stale harness lock reference, and give concurrent `ServerRuntime` instances runtime-owned native log sinks.

**Architecture:** Provider worker futures receive a lightweight generation-observation lease while the terminal manager alone owns the worker registry. Callback isolation exposes both named admission resources to tests. Native tracing remains one process-wide stream, but a process-owned sink registry mirrors it to every live runtime-owned rotating log writer through exact-drop leases.

**Tech Stack:** Rust 2024, Tokio, `tracing`, `tracing-subscriber`, Axum server lifecycle, standard-library `Arc`/`Mutex`, Cargo test harness.

## Global Constraints

- Do not add or restore a broad process test lock, `--test-threads=1`, a mutable environment/CWD override, a sleep-based ordering assertion, or a widened production timeout.
- Every concurrency assertion must use a positive channel, semaphore, barrier, task join, or process/thread completion event; timeouts are bounded failure watchdogs only.
- No lock may be held across an async wait, file write, flush, rotation, OS-thread join, or Tokio task join.
- The public RPC, persistence, `ServerConfig`, provider timeout, and terminal timeout surfaces remain unchanged.
- Native tracing is process-wide. Concurrent embedded runtimes receive mirrored process records, not semantically partitioned records.
- Normal production has one active log sink; multi-runtime write cost is `O(active runtime sinks)` and the sink registry is bounded by live leases.
- The existing 4 MiB server-log size bound and three retained backups remain unchanged.
- Implement each behavior test-first and run it with Rust test threads enabled; do not infer readiness from `yield_now`, file existence, or elapsed time.

---

### Task 1: Break the terminal observer generation/worker ownership cycle

**Files:**
- Modify: `apps/server/src/provider_terminal/model.rs`
- Modify: `apps/server/src/provider_terminal/codex.rs`
- Modify: `apps/server/src/provider_terminal/claude.rs`
- Modify: `apps/server/src/provider_terminal/opencode.rs`
- Modify: `apps/server/src/terminal/manager.rs`
- Modify: `docs/architecture/activity-observation.md`

**Interfaces:**
- Consumes: existing `TerminalObserverWorkerContext`, `TerminalObserverWorkerRegistry`, `TerminalObserverGeneration`, `PreparedTerminalObserver`, and provider observer loops.
- Produces: `TerminalObserverGenerationLease`, a lightweight cloneable observation/publication handle that cannot retain the manager-owned worker registry.
- Produces: `TerminalObserverGeneration::observation() -> TerminalObserverGenerationLease`; manager-owned `TerminalObserverGeneration` continues to expose `worker_context`, cancellation, invalidation, and worker shutdown.
- Changes internal trait input to `PreparedTerminalObserver::on_spawned(&self, pid: u32, generation: TerminalObserverGenerationLease, workers: TerminalObserverWorkerContext)` and the corresponding `set_agent_activity_enabled` generation input.

- [ ] **Step 1: Write a production-graph failing regression**

Add a provider-neutral model test whose spawned worker captures the same lightweight generation value that production provider observers capture, waits on its cancellation signal, and positively reports worker exit. Drop/abort the sole manager owner, then prove the one-slot worker semaphore is returned and an exact replacement generation can start a worker.

```rust
#[tokio::test]
async fn dropping_generation_owner_cancels_a_worker_that_holds_observation_lease() {
    let slots = Arc::new(tokio::sync::Semaphore::new(1));
    let generation = TerminalObserverGeneration::new_with_runtime_and_worker_slots(
        "thread".into(),
        "terminal".into(),
        Handle::try_current().ok(),
        slots.clone(),
    );
    let observation = generation.observation();
    let (started_tx, started_rx) = oneshot::channel();
    let (exited_tx, exited_rx) = oneshot::channel();
    generation.worker_context().spawn(async move {
        let _ = started_tx.send(());
        observation.cancelled().await;
        let _ = exited_tx.send(());
    }).expect("first worker");
    started_rx.await.expect("worker started");

    drop(generation);
    exited_rx.await.expect("worker exited after owner drop");
    assert_eq!(slots.available_permits(), 1);

    let replacement = TerminalObserverGeneration::new_with_runtime_and_worker_slots(
        "thread-2".into(),
        "terminal-2".into(),
        Handle::try_current().ok(),
        slots,
    );
    replacement.worker_context().spawn(async {}).expect("replacement worker");
}
```

- [ ] **Step 2: Run the exact regression and preserve the RED evidence**

Run:

```bash
cargo test -p bibcode-server --lib provider_terminal::model::tests::dropping_generation_owner_cancels_a_worker_that_holds_observation_lease -- --exact --nocapture
```

Expected: compile failure because `TerminalObserverGenerationLease`/`observation` do not exist, or behavioral failure because the production ownership cycle keeps the worker/permit alive.

- [ ] **Step 3: Split observation state from worker ownership**

Reshape the model so the core contains generation identity/publication/cancellation only and the manager owner separately contains the registry:

```rust
#[derive(Debug)]
struct TerminalObserverGenerationInner {
    id: Uuid,
    scope_id: String,
    thread_id: String,
    terminal_id: String,
    current: AtomicBool,
    activity_publication: StdMutex<Option<Arc<AsyncMutex<()>>>>,
    cancellation_reason: StdMutex<Option<TerminalObserverCancellationReason>>,
    cancellation_requested_while_current: AtomicBool,
    cancellation: CancellationToken,
}

#[derive(Clone, Debug)]
pub struct TerminalObserverGenerationLease {
    inner: Arc<TerminalObserverGenerationInner>,
}

#[derive(Clone, Debug)]
pub struct TerminalObserverGeneration {
    observation: TerminalObserverGenerationLease,
    workers: TerminalObserverWorkerContext,
}

impl TerminalObserverGeneration {
    #[must_use]
    pub fn observation(&self) -> TerminalObserverGenerationLease {
        self.observation.clone()
    }

    #[must_use]
    pub fn worker_context(&self) -> TerminalObserverWorkerContext {
        self.workers.clone()
    }
}
```

Put identity, current-state, namespace, cancellation-wait, and activity-publication methods on `TerminalObserverGenerationLease`. Keep lifecycle mutations on the manager owner, delegating to the lease and separately stopping/shutting down `workers`.

- [ ] **Step 4: Migrate all provider worker captures**

Change `PreparedTerminalObserver` and the Codex, Claude, and OpenCode implementations so their spawned futures capture only `TerminalObserverGenerationLease`. Change `TerminalGenerationActivityPublisher` to store the lease rather than the manager owner:

```rust
fn on_spawned(
    &self,
    pid: u32,
    generation: TerminalObserverGenerationLease,
    workers: TerminalObserverWorkerContext,
);

pub struct TerminalGenerationActivityPublisher {
    generation: TerminalObserverGenerationLease,
    projection: ActivityProjection,
    publication: Arc<AsyncMutex<()>>,
}
```

At the manager callback boundary pass `state.generation.observation()` and `state.generation.worker_context()` as two independent values. Search the three provider files and prove no worker future captures `TerminalObserverGeneration`.

- [ ] **Step 5: Run focused generation and provider tests**

Run:

```bash
cargo test -p bibcode-server --lib provider_terminal::model::tests -- --test-threads=8
cargo test -p bibcode-server --lib provider_terminal::codex::tests -- --test-threads=8
cargo test -p bibcode-server --lib provider_terminal::claude::tests -- --test-threads=8
cargo test -p bibcode-server --lib provider_terminal::opencode::tests -- --test-threads=8
cargo test -p bibcode-server --lib terminal::manager::tests -- --test-threads=8
```

Expected: all pass; the new owner-drop test reports positive worker exit and exact permit reuse.

- [ ] **Step 6: Update the lifecycle documentation and commit**

Document that provider observer workers may retain only the observation lease, while the manager generation owner retains the registry and its final drop cancels/drains workers. Then run `git diff --check` and commit:

```bash
git add apps/server/src/provider_terminal/model.rs \
  apps/server/src/provider_terminal/codex.rs \
  apps/server/src/provider_terminal/claude.rs \
  apps/server/src/provider_terminal/opencode.rs \
  apps/server/src/terminal/manager.rs \
  docs/architecture/activity-observation.md
git commit -m "fix(provider): separate observer worker ownership"
```

---

### Task 2: Prove both callback permits and remove the dead harness lock API

**Files:**
- Modify: `apps/server/src/terminal/manager.rs`
- Modify: `apps/server/tests/fixtures/task8-harness/src/lib.rs`

**Interfaces:**
- Consumes: existing `ObserverCallbackIsolation { slots, global_slots }`.
- Produces: test-only `ObserverCallbackIsolation::with_slots(slots, global_slots)` so tests own both exact admission resources.
- Removes: dead `external_process_test_lock()` harness function and all repository references to the deleted broad lock.

- [ ] **Step 1: Strengthen the callback cancellation RED**

Replace the global-only injected constructor in the abort and panic tests with two one-slot semaphores. Positively gate the OS callback thread, abort the caller, and prove neither permit can be acquired before thread exit:

```rust
let local = Arc::new(Semaphore::new(1));
let global = Arc::new(Semaphore::new(1));
let isolation = ObserverCallbackIsolation::with_slots(local.clone(), global.clone());

started.await.expect("callback thread started");
caller.abort();
assert!(local.clone().try_acquire_owned().is_err());
assert!(global.clone().try_acquire_owned().is_err());
release.send(()).expect("release callback thread");
exited.await.expect("callback thread exited");
assert!(local.try_acquire_owned().is_ok());
assert!(global.try_acquire_owned().is_ok());
```

- [ ] **Step 2: Run the exact test and verify the old seam cannot prove local ownership**

Run the two existing callback abort/panic exact tests. Expected RED: compile failure for `with_slots`, followed by the behavioral assertions becoming meaningful only after both semaphores are injected.

- [ ] **Step 3: Add the minimal test-only constructor and make both tests GREEN**

```rust
#[cfg(test)]
impl ObserverCallbackIsolation {
    fn with_slots(
        slots: Arc<tokio::sync::Semaphore>,
        global_slots: Arc<tokio::sync::Semaphore>,
    ) -> Self {
        Self { slots, global_slots }
    }
}
```

Delete `with_global_slots` once all tests use the two-resource constructor. Run the manager module at eight threads.

- [ ] **Step 4: Remove and verify the stale harness API**

Delete only this dead function:

```rust
#[cfg(test)]
pub fn external_process_test_lock() -> &'static tokio::sync::Mutex<()> {
    &process::EXTERNAL_PROCESS_TEST_LOCK
}
```

Then run:

```bash
rg -n '(?:EXTERNAL|SYSTEM)_PROCESS_TEST_LOCK|TEST_INITIALIZE_LOCK|GLOBAL_OBSERVER_WORKER_TEST_LOCK' apps/server
cargo test --manifest-path apps/server/tests/fixtures/task8-harness/Cargo.toml -- --test-threads=8
cargo test -p bibcode-server --lib terminal::manager::tests -- --test-threads=8
```

Expected: `rg` returns no matches; the standalone harness and manager tests pass.

- [ ] **Step 5: Commit the callback/harness repair**

```bash
git add apps/server/src/terminal/manager.rs \
  apps/server/tests/fixtures/task8-harness/src/lib.rs
git commit -m "test(server): verify callback permit ownership"
```

---

### Task 3: Replace global log retargeting with runtime-owned sink leases

**Files:**
- Modify: `apps/server/src/logging.rs`
- Modify: `apps/server/src/lifecycle.rs`
- Modify: `apps/server/tests/server_runtime.rs`
- Modify: `docs/operations/observability.md`

**Interfaces:**
- Consumes: existing `LogWriter`, `RotatingFile`, public `logging::initialize`, `ServerRuntime::start_internal`, and `ServerHandle` shutdown/join lifecycle.
- Produces: crate-private `logging::initialize_owned(log_path: &Path) -> Result<LogSinkLease, LoggingError>`.
- Produces: process-owned `LogSinkRegistry`, exact-drop `LogSinkLease`, and registry-backed `MakeWriter`/composite writer.
- Preserves: `pub fn initialize(log_path: &Path) -> Result<Init, LoggingError>` with first-call process-lifetime ownership and no later retarget.

- [ ] **Step 1: Add the production-compiled two-runtime integration RED**

In `apps/server/tests/server_runtime.rs`, start two real runtimes concurrently against distinct `TempDir` roots. After both starts, emit a unique tracing marker and flush/read both server logs. Then join the left runtime, remove/drop its root, emit another marker, and prove only the still-live right sink advances.

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_runtimes_retain_owned_log_sinks_without_retargeting() {
    let (left, right) = tokio::join!(
        ServerRuntime::start_with_registry(left_config, RpcRegistry::new()),
        ServerRuntime::start_with_registry(right_config, RpcRegistry::new()),
    );
    let left = left.expect("left runtime");
    let right = right.expect("right runtime");

    tracing::info!(target: "runtime_log_sink_registry_test", marker = %marker_a);
    assert_log_contains(&left_log, &marker_a).await;
    assert_log_contains(&right_log, &marker_a).await;

    left.shutdown();
    left.join().await.expect("left join");
    let left_before = tokio::fs::read(&left_log).await.expect("left snapshot");
    tracing::info!(target: "runtime_log_sink_registry_test", marker = %marker_b);
    assert_log_contains(&right_log, &marker_b).await;
    assert_eq!(tokio::fs::read(&left_log).await.expect("left unchanged"), left_before);
}
```

Use existing deterministic file-flush/test instrumentation or a test-only positive writer event in `logging.rs`; do not add polling sleeps.

- [ ] **Step 2: Run the integration test and capture the retarget RED**

```bash
cargo test -p bibcode-server --test server_runtime concurrent_runtimes_retain_owned_log_sinks_without_retargeting -- --exact --nocapture --test-threads=8
```

Expected: marker A appears only in the last-targeted log or teardown/marker B touches the stale target.

- [ ] **Step 3: Implement the registry and exact-drop lease**

Use one registry mutex only for identity allocation and map snapshots:

```rust
#[derive(Default)]
struct LogSinkRegistryState {
    next_id: u64,
    sinks: BTreeMap<u64, LogWriter>,
}

struct LogSinkRegistry {
    state: Mutex<LogSinkRegistryState>,
}

pub(crate) struct LogSinkLease {
    registry: Arc<LogSinkRegistry>,
    id: u64,
}

impl Drop for LogSinkLease {
    fn drop(&mut self) {
        self.registry.remove_exact(self.id);
    }
}
```

`register` inserts the opened writer and returns the lease. `remove_exact` removes only the matching identity. The registry `MakeWriter` snapshots cloned `LogWriter` handles before constructing the composite writer.

- [ ] **Step 4: Implement attempt-all composite writes**

```rust
struct MultiLogWriter {
    writers: Vec<LogWriter>,
}

impl LogWriter {
    fn write_record(&self, buffer: &[u8]) -> std::io::Result<()> {
        let mut writer = self.make_writer();
        writer.write_all(buffer)?;
        writer.flush()
    }
}

impl Write for MultiLogWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let mut accepted = false;
        let mut last_error = None;
        for writer in &self.writers {
            match writer.write_record(buffer) {
                Ok(()) => accepted = true,
                Err(error) => last_error = Some(error),
            }
        }
        if accepted || self.writers.is_empty() {
            Ok(buffer.len())
        } else {
            Err(last_error.expect("every non-empty sink write failed"))
        }
    }
}
```

Keep all per-file write/rotation locks outside the registry lock. Add focused unit tests for exact lease removal, terminal-entry pruning, and a failing sink not starving a healthy sink.

- [ ] **Step 5: Add owned initialization while preserving the public API**

Install the global subscriber once with the registry-backed writer. `initialize_owned` returns a lease; public `initialize` retains the first successful lease for process lifetime and returns `AlreadyInstalled` thereafter without replacing any writer.

```rust
pub(crate) fn initialize_owned(log_path: &Path) -> Result<LogSinkLease, LoggingError>;

pub fn initialize(log_path: &Path) -> Result<Init, LoggingError> {
    let _guard = INITIALIZE_LOCK.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if PROCESS_LOG_SINK.get().is_some() {
        return Ok(Init::AlreadyInstalled);
    }
    let lease = initialize_owned_locked(log_path)?;
    PROCESS_LOG_SINK.set(lease)
        .map_err(|_| LoggingError::InstallSubscriber(
            "process log sink was installed concurrently".into(),
        ))?;
    Ok(Init::Installed)
}
```

Both public `initialize` and crate-private `initialize_owned` call one `initialize_owned_locked` helper while holding `INITIALIZE_LOCK`; do not recursively lock it. Serialize first subscriber installation and provisional registration with that lock. On `try_init` failure, drop the provisional lease. Do not keep `ACTIVE_LOG_WRITER::replace`.

- [ ] **Step 6: Retain the lease through the actual server task lifetime**

Change `ServerRuntime::start_internal` to call `initialize_owned`. Give the server task and handle shared ownership so handle drop cannot remove the sink while the task may still log:

```rust
let log_sink = Arc::new(logging::initialize_owned(&state_paths.server_log)?);
let task_log_sink = log_sink.clone();
let task = tokio::spawn(async move {
    let _log_sink = task_log_sink;
    // serve and production-runtime shutdown
});

pub struct ServerHandle {
    // existing fields
    _log_sink: Arc<logging::LogSinkLease>,
}
```

If the concrete lifecycle uses a different retained owner to keep cleanup alive after handle drop, store the clone there instead; the invariant is last-drop only after the task can no longer emit.

- [ ] **Step 7: Make focused logging/lifecycle tests GREEN**

Run:

```bash
cargo test -p bibcode-server --lib logging::tests -- --test-threads=8
cargo test -p bibcode-server --lib lifecycle::tests -- --test-threads=8
cargo test -p bibcode-server --test server_runtime concurrent_runtimes_retain_owned_log_sinks_without_retargeting -- --exact --nocapture --test-threads=8
```

Expected: all pass without a broad logging lock or retargeting static.

- [ ] **Step 8: Update observability documentation and commit**

State that native tracing is one process stream, every active runtime-owned sink receives mirrored events, production normally has one sink, and exact lease drop prevents one runtime from retargeting/tearing down another.

```bash
git add apps/server/src/logging.rs \
  apps/server/src/lifecycle.rs \
  apps/server/tests/server_runtime.rs \
  docs/operations/observability.md
git commit -m "fix(server): retain runtime-owned log sinks"
```

---

### Task 4: Parallel verification, review, and Task 6 closeout

**Files:**
- Modify: `.superpowers/sdd/2026-08-11-parallel-rust-test-sandboxes/task-6-report.md` (ignored evidence only; never stage)
- Modify: `.superpowers/sdd/2026-08-11-parallel-rust-test-sandboxes/progress.md` (ignored ledger only; never stage)

**Interfaces:**
- Consumes: Tasks 1-3 and the initial Task 6 commit `7fc38831`.
- Produces: complete parallel verification evidence and an independent Critical/Important review verdict.

- [ ] **Step 1: Run the complete lock/global-mutation inventory**

```bash
rg -n '(?:EXTERNAL|SYSTEM)_PROCESS_TEST_LOCK|TEST_INITIALIZE_LOCK|GLOBAL_OBSERVER_WORKER_TEST_LOCK' apps/server
rg -n 'set_var\(|remove_var\(|set_current_dir\(' apps/server/src apps/server/tests
```

Expected: no broad lock references. Any remaining environment/CWD mutation must be inside an exact isolated child protocol already documented by Tasks 2-4 of the parent plan.

- [ ] **Step 2: Run all formerly locked suites at eight threads**

```bash
cargo test -p bibcode-server --lib lifecycle::tests -- --test-threads=8
cargo test -p bibcode-server --lib production::control::tests -- --test-threads=8
cargo test -p bibcode-server --lib production::runtime::tests -- --test-threads=8
cargo test -p bibcode-server --lib production::server_terminal::tests -- --test-threads=8
cargo test -p bibcode-server --lib logging::tests -- --test-threads=8
cargo test -p bibcode-server --lib provider_usage::codex_backend::tests -- --test-threads=8
cargo test --manifest-path apps/server/tests/fixtures/task8-harness/Cargo.toml -- --test-threads=8
```

Expected: all pass without serial flags or test-global convoys.

- [ ] **Step 3: Run the full parallel server library and static gates**

```bash
cargo test -p bibcode-server --lib -- --test-threads=8
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
vp check
vp run typecheck
git diff --check
```

Record exact counts, durations, warnings, and every command exit. Do not call a timeout/load failure green; isolate it and classify its ownership before changing code or assertions.

- [ ] **Step 4: Run independent two-stage review**

Request spec-compliance review first, then code-quality review. The review must inspect:

```text
generation owner -> worker registry -> worker future -> observation lease
callback caller cancellation -> local permit + global permit -> OS-thread exit
runtime/server task -> log-sink lease -> exact registry entry -> rotating writer
subscriber install failure -> provisional lease rollback
runtime join/drop -> final sink removal
```

Any Critical/Important finding reopens the owning task with deterministic RED-to-GREEN evidence before completion.

- [ ] **Step 5: Final scope audit and report**

```bash
git status --short
git diff --stat 7fc38831..HEAD
git diff --check 7fc38831..HEAD
git diff --name-only 7fc38831..HEAD | rg '^(\.repos|\.codegraph|\.superpowers)/' || true
```

Append the RED/GREEN commands, test counts, review verdicts, and residual platform risks to the ignored Task 6 report and ledger. Confirm ignored evidence, `.codegraph`, and `.repos` are not staged or committed.

- [ ] **Step 6: Commit only a report-relevant tracked correction if one exists**

Task 4 normally creates no tracked commit. If final review requires a tracked living-doc correction, stage only that file and use:

```bash
git commit -m "docs(server): finalize parallel runtime ownership"
```
