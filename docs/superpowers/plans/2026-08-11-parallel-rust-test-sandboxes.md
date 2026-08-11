# Parallel Rust Test Sandboxes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the server and desktop Rust suites reliable with Rust's default parallel test threads while their workspace tasks also run concurrently.

**Architecture:** Private, instance-owned test sandboxes provide unique filesystem/network/process resources and lost-wake-safe lifecycle events. Existing command-local environment, executable, CWD, cancellation, output-drain, and reap boundaries replace process-global mutation and broad test locks; irreducible global-state tests run in isolated child test processes.

**Tech Stack:** Rust 1.97.1, Tokio, tempfile, Cargo, Vite+, GitHub Actions.

## Global Constraints

- Production provider, Git, relay, terminal, RPC, and desktop command deadlines remain unchanged.
- No public API, RPC/protocol, persistence, authentication, or production dependency changes.
- Testability seams are private `pub(crate)`, private trait fields, or `#[cfg(test)]`.
- Parallel in-process tests never call `std::env::set_var`, `std::env::remove_var`, or `std::env::set_current_dir`.
- Ordering is established by channels or monotonic events; sleeps, yields, polling, and wall-clock timeouts are diagnostic bounds only.
- Tests keep real child processes, local listeners, bounded stdout/stderr, cancellation, RPC, and exact reap/cleanup assertions.
- Do not serialize Vite+ tasks, Cargo package tasks, or Rust test binaries.
- A newly exposed production race receives a deterministic RED-to-GREEN regression in its owning module before work continues.

---

### Task 1: Add lost-wake-safe server fixture primitives

**Files:**
- Create: `apps/server/src/test_support/mod.rs`
- Create: `apps/server/src/test_support/event.rs`
- Create: `apps/server/src/test_support/sandbox.rs`
- Modify: `apps/server/src/lib.rs`

**Interfaces:**
- Produces: `TestSandbox::new`, `TestSandbox::path`, generic `TestSandbox::environment<I, K, V>`, cross-platform `TestSandbox::executable_script(name, unix_body, windows_body)`, `FixtureEvent::checkpoint`, `FixtureEvent::publish`, `FixtureEvent::wait_after`, and `FixtureLease`.
- Consumers: Tasks 2–6.

- [ ] **Step 1: Register the private test-support module and write the RED tests**

Add to `apps/server/src/lib.rs`:

```rust
#[cfg(test)]
pub(crate) mod test_support;
```

Add tests in `apps/server/src/test_support/mod.rs`:

```rust
#[tokio::test]
async fn sandboxes_and_events_are_parallel_and_resource_distinct() {
    let first = TestSandbox::new("first");
    let second = TestSandbox::new("second");
    assert_ne!(first.root(), second.root());
    assert_ne!(first.path("child.pid"), second.path("child.pid"));

    let event = FixtureEvent::default();
    let checkpoint = event.checkpoint();
    event.publish();
    event.wait_after(checkpoint).await;
}

#[tokio::test]
async fn fixture_lease_counts_concurrent_resources_and_releases_on_drop() {
    let sandbox = TestSandbox::new("leases");
    let first = sandbox.acquire_fixture();
    let second = sandbox.acquire_fixture();
    assert_eq!(sandbox.active_fixtures(), 2);
    assert_eq!(sandbox.maximum_active_fixtures(), 2);
    drop(first);
    drop(second);
    assert_eq!(sandbox.active_fixtures(), 0);
}

#[test]
fn fixture_lease_releases_during_panic_unwind() {
    let sandbox = TestSandbox::new("panic-release");
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _lease = sandbox.acquire_fixture();
        panic!("fixture panic");
    }));
    assert!(result.is_err());
    assert_eq!(sandbox.active_fixtures(), 0);
}
```

- [ ] **Step 2: Run the RED tests**

Run:

```bash
cargo test -p bibcode-server --lib test_support::tests -- --test-threads=8
```

Expected: compile failure because the three test-support modules and types do not exist.

- [ ] **Step 3: Implement the monotonic event without a lost-wake window**

Use this contract in `event.rs`:

```rust
#[derive(Debug, Default)]
pub(crate) struct FixtureEvent {
    generation: AtomicU64,
    changed: Notify,
}

impl FixtureEvent {
    pub(crate) fn checkpoint(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    pub(crate) fn publish(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.changed.notify_waiters();
    }

    pub(crate) async fn wait_after(&self, checkpoint: u64) {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.generation.load(Ordering::Acquire) > checkpoint {
                return;
            }
            notified.await;
        }
    }
}
```

- [ ] **Step 4: Implement cross-platform sandbox ownership**

`sandbox.rs` owns a `TempDir`, an immutable snapshot of `std::env::vars()`, and atomic active/maximum fixture counts. `executable_script(name, unix_body, windows_body)` writes an executable `.sh` file with mode `0o700` on Unix and a `.cmd` file on Windows. It returns the explicit path; callers do not add the directory to `PATH`.

```rust
pub(crate) struct TestSandbox {
    root: TempDir,
    environment: BTreeMap<String, String>,
    active: Arc<AtomicUsize>,
    maximum: Arc<AtomicUsize>,
}

pub(crate) struct FixtureLease {
    active: Arc<AtomicUsize>,
}

impl TestSandbox {
    pub(crate) fn environment<I, K, V>(&self, overrides: I) -> BTreeMap<String, String>
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        let mut environment = self.environment.clone();
        environment.extend(
            overrides
                .into_iter()
                .map(|(key, value)| (key.into(), value.into())),
        );
        environment
    }
}

impl Drop for FixtureLease {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::AcqRel);
    }
}
```

`TestSandbox::environment` clones the captured map and applies explicit overrides; it never mutates the parent environment.

- [ ] **Step 5: Run GREEN, static checks, and commit**

```bash
cargo test -p bibcode-server --lib test_support::tests -- --test-threads=8
cargo fmt --all --check
cargo clippy -p bibcode-server --lib -- -D warnings
git add apps/server/src/lib.rs apps/server/src/test_support
git commit -m "test(server): add owned parallel fixture sandbox"
```

### Task 2: Make generic process fixtures independent

**Files:**
- Modify: `apps/server/src/test_support/sandbox.rs`
- Modify: `apps/server/src/process/runner.rs`
- Modify: `apps/server/src/git/process.rs`
- Modify: `apps/server/src/vcs/mod.rs`

**Interfaces:**
- Consumes: `TestSandbox` and existing `ProcessRunInput::{env,cwd,spawn_cwd}` fields.
- Produces: `TestSandbox::process_input(executable, args) -> ProcessRunInput` and parallel process-runner coverage without `EXTERNAL_PROCESS_TEST_LOCK`.

- [ ] **Step 1: Write the RED concurrent process test**

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn runner_uses_command_local_environment_for_parallel_children() {
    async fn run(label: &str) -> ProcessRunOutput {
        let sandbox = TestSandbox::new(label);
        let script = sandbox.executable_script(
            "print-label",
            "printf '%s' \"$FIXTURE_LABEL\"",
            "@echo off\r\n<nul set /p =%FIXTURE_LABEL%",
        );
        let mut input = sandbox.process_input(script, Vec::<String>::new());
        input.env = Some(sandbox.environment([("FIXTURE_LABEL", label)]));
        ProcessRunner.run(input).await.expect("parallel fixture process")
    }

    let (left, right) = tokio::join!(run("left"), run("right"));
    assert_eq!(left.stdout, "left");
    assert_eq!(right.stdout, "right");
}
```

- [ ] **Step 2: Run RED**

```bash
cargo test -p bibcode-server --lib process::runner::tests::runner_uses_command_local_environment_for_parallel_children -- --exact
```

Expected: compile failure until `process_input` exists.

- [ ] **Step 3: Implement the input helper and remove unjustified locks**

`process_input` uses the explicit executable path, the sandbox root as `spawn_cwd`, and the captured environment. Do not change `ProcessRunInput`'s public shape or `ProcessRunner`'s production defaults.

Remove `EXTERNAL_PROCESS_TEST_LOCK` from process/git/vcs tests that use only unique temp roots and command-local state. Add paired concurrent tests for bounded output, cancellation, and timeout results.

- [ ] **Step 4: Run GREEN and commit**

```bash
cargo test -p bibcode-server --lib process::runner::tests -- --test-threads=8
cargo test -p bibcode-server --lib git::process::tests -- --test-threads=8
cargo test -p bibcode-server --lib vcs::tests -- --test-threads=8
cargo clippy -p bibcode-server --lib -- -D warnings
git add apps/server/src/test_support/sandbox.rs apps/server/src/process/runner.rs apps/server/src/git/process.rs apps/server/src/vcs/mod.rs
git commit -m "test(process): isolate parallel child launches"
```

### Task 3: Isolate Git and source-control command fixtures

**Files:**
- Modify: `apps/server/src/production/git_vcs.rs`
- Modify: `apps/server/src/source_control/pull_request.rs`
- Modify: `apps/server/src/production/orchestration_effects.rs`
- Modify: `apps/server/src/git/repository.rs`

**Interfaces:**
- Consumes: explicit `GitRepository` runner ownership, `PullRequestService::with_provider_commands`, and `TestSandbox` executable paths.
- Produces: no `PATH` mutation and no broad lock in Git/source-control fixtures.

- [ ] **Step 1: Add the paired explicit-provider RED test**

```rust
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn provider_cli_fixtures_are_instance_owned_in_parallel() {
    async fn resolve(label: &str) -> ResolvedPullRequest {
        let sandbox = TestSandbox::new(label);
        let command = sandbox.executable_script(
            "gh",
            &format!("printf '%s\\n' '{{\"number\":42,\"title\":\"{label}\",\"url\":\"https://example.test/42\",\"baseRefName\":\"main\",\"headRefName\":\"feature\",\"state\":\"OPEN\"}}'"),
            "",
        );
        PullRequestService::with_provider_commands(
            command.to_string_lossy(),
            "unused-glab",
            "unused-az",
        )
        .resolve_current(
            ResolvePullRequestInput {
                cwd: sandbox.root().to_path_buf(),
                provider: ProviderKind::Github,
                reference: "feature".to_owned(),
            },
            &CancellationToken::new(),
        )
        .await
        .expect("resolve fixture PR")
    }

    let (left, right) = tokio::join!(resolve("left"), resolve("right"));
    assert_eq!(left.title, "left");
    assert_eq!(right.title, "right");
}
```

- [ ] **Step 2: Run RED and identify remaining global mutation**

```bash
cargo test -p bibcode-server --lib source_control::pull_request::tests::provider_cli_fixtures_are_instance_owned_in_parallel -- --exact
rg -n "EnvGuard|set_var|remove_var|EXTERNAL_PROCESS_TEST_LOCK" apps/server/src/production/git_vcs.rs apps/server/src/source_control/pull_request.rs apps/server/src/production/orchestration_effects.rs
```

Expected: new test initially fails to compile or exposes a shared command path; the search reports the existing global fixtures/locks.

- [ ] **Step 3: Migrate each fixture to owned inputs**

Use explicit provider command paths. Use the existing `GitRepository` runner abstraction for fake Git outcomes. For real Git coverage, use repositories under each sandbox root and command-local environment via `ProcessRequest`; do not mutate `PATH` or `BIBCODE_TEST_REMOTE` globally.

Delete `EnvGuard` and remove each broad lock only after its test owns all executable/environment/repository state.

- [ ] **Step 4: Run module and parallel GREEN tests, then commit**

```bash
cargo test -p bibcode-server --lib production::git_vcs::tests -- --test-threads=8
cargo test -p bibcode-server --lib source_control::pull_request::tests -- --test-threads=8
cargo test -p bibcode-server --lib production::orchestration_effects::tests -- --test-threads=8
rg -n "EnvGuard|set_var|remove_var|EXTERNAL_PROCESS_TEST_LOCK" apps/server/src/production/git_vcs.rs apps/server/src/source_control/pull_request.rs apps/server/src/production/orchestration_effects.rs
git add apps/server/src/production/git_vcs.rs apps/server/src/source_control/pull_request.rs apps/server/src/production/orchestration_effects.rs apps/server/src/git/repository.rs
git commit -m "test(git): isolate parallel command fixtures"
```

Expected search result: no test-global mutation or broad lock remains in the listed files.

### Task 4: Isolate provider environment and current-directory coverage

**Files:**
- Modify: `apps/server/src/production/provider_inventory.rs`
- Modify: `apps/server/src/production/provider_maintenance.rs`
- Modify: `apps/server/src/production/provider_runtime.rs`
- Modify: `apps/server/tests/provider_usage_domain.rs`

**Interfaces:**
- Consumes: explicit provider executable/environment/CWD inputs and `TestSandbox`.
- Produces: child-process protocols `BIBCODE_TEST_ISOLATED_CASE=missing-cwd` and `BIBCODE_TEST_ISOLATED_CASE=provider-usage-env` for tests whose subject is process-global environment/CWD behavior.

- [ ] **Step 1: Write the isolated-child RED harness**

Parent test:

```rust
fn run_isolated_case(case: &str, test_name: &str) -> Output {
    Command::new(std::env::current_exe().expect("current test binary"))
        .args(["--exact", test_name, "--nocapture", "--test-threads=1"])
        .env("BIBCODE_TEST_ISOLATED_CASE", case)
        .output()
        .expect("run isolated fixture case")
}
```

Child branch:

```rust
if std::env::var("BIBCODE_TEST_ISOLATED_CASE").as_deref() == Ok("missing-cwd") {
    let directory = tempfile::tempdir().expect("isolated CWD");
    std::env::set_current_dir(directory.path()).expect("enter isolated CWD");
    std::fs::remove_dir_all(directory.path()).expect("remove isolated CWD");
    assert!(resolve_provider_cwd().is_err());
    return;
}
```

Only the exact child process mutates its own CWD; the parent test process remains parallel-safe.

- [ ] **Step 2: Run RED**

```bash
cargo test -p bibcode-server --lib production::provider_runtime::tests::invalid_cwd_cases_are_process_isolated -- --exact
```

Expected: compile failure until the parent/child protocol replaces `CurrentDirectoryGuard`.

- [ ] **Step 3: Migrate provider fixtures**

Tests that merely need a fake provider receive an explicit executable path and environment. Tests whose subject is ambient `PATH`, provider home variables, or missing CWD use the exact child protocol. Remove `EnvGuard`, `CurrentDirectoryGuard`, unsafe environment mutation from the parent test process, and the corresponding broad locks.

The `provider_usage_domain` integration binary uses the same child protocol for `CODEX_HOME`, `CODEX_BIN`, `CLAUDE_CONFIG_DIR`, and keychain variables so its sibling tests can run in parallel.

- [ ] **Step 4: Run GREEN, search, and commit**

```bash
cargo test -p bibcode-server --lib production::provider_inventory::tests -- --test-threads=8
cargo test -p bibcode-server --lib production::provider_maintenance::tests -- --test-threads=8
cargo test -p bibcode-server --lib production::provider_runtime::tests -- --test-threads=8
cargo test -p bibcode-server --test provider_usage_domain -- --test-threads=8
rg -n "CurrentDirectoryGuard|EnvGuard|set_var|remove_var|set_current_dir|EXTERNAL_PROCESS_TEST_LOCK" apps/server/src/production/provider_inventory.rs apps/server/src/production/provider_maintenance.rs apps/server/src/production/provider_runtime.rs apps/server/tests/provider_usage_domain.rs
git add apps/server/src/production/provider_inventory.rs apps/server/src/production/provider_maintenance.rs apps/server/src/production/provider_runtime.rs apps/server/tests/provider_usage_domain.rs
git commit -m "test(provider): isolate ambient process state"
```

Expected search result: mutation exists only inside the explicitly detected isolated-child branch; no parent-process guard or broad lock remains.

### Task 5: Make provider-terminal and relay fixtures positively synchronized

**Files:**
- Modify: `apps/server/src/provider_terminal/claude.rs`
- Modify: `apps/server/src/provider_terminal/codex.rs`
- Modify: `apps/server/src/provider_terminal/opencode.rs`
- Modify: `apps/server/src/production/relay.rs`

**Interfaces:**
- Consumes: `FixtureEvent`, `TestSandbox`, existing supervised process ownership, and existing private timeout constructors.
- Produces: paired real-process tests with atomic PID publication and no `SYSTEM_PROCESS_TEST_LOCK`.

- [ ] **Step 1: Write paired RED regressions**

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_codex_helpers_publish_distinct_pids_and_reap_in_parallel() {
    let left = helper_fixture(TestSandbox::new("left"));
    let right = helper_fixture(TestSandbox::new("right"));
    let ((left_helper, left_pid), (right_helper, right_pid)) =
        tokio::join!(left.start_and_wait(), right.start_and_wait());
    assert_ne!(left_pid.expect("left PID"), right_pid.expect("right PID"));
    left_helper.expect("left helper").terminate();
    right_helper.expect("right helper").terminate();
    tokio::join!(left.wait_reaped(), right.wait_reaped());
}
```

Add equivalent paired bounded-output probes and an OpenCode invalid-readiness pair using separate sandboxes.

- [ ] **Step 2: Run RED**

```bash
cargo test -p bibcode-server --lib provider_terminal::codex::tests::two_codex_helpers_publish_distinct_pids_and_reap_in_parallel -- --exact
```

Expected: failure while fixtures still depend on module/global locks or polling.

- [ ] **Step 3: Replace observation races with positive events**

Start/poll the real launch future before waiting. Publish PID files atomically (`pid.tmp` then rename), signal readiness through `FixtureEvent`, retain listeners/sockets, and await cancellation/reap events. Generate bounded-output fixture data efficiently while exceeding the configured limit on both streams.

Keep production timeout constants unchanged. Existing longer test-only bounds remain only as outer watchdogs; remove them where positive barriers make them redundant. Remove `SYSTEM_PROCESS_TEST_LOCK` and provider/relay `EXTERNAL_PROCESS_TEST_LOCK` acquisitions.

- [ ] **Step 4: Run GREEN and commit**

```bash
cargo test -p bibcode-server --lib provider_terminal::claude::tests -- --test-threads=8
cargo test -p bibcode-server --lib provider_terminal::codex::tests -- --test-threads=8
cargo test -p bibcode-server --lib provider_terminal::opencode::tests -- --test-threads=8
cargo test -p bibcode-server --lib production::relay::tests -- --test-threads=8
rg -n "SYSTEM_PROCESS_TEST_LOCK|EXTERNAL_PROCESS_TEST_LOCK" apps/server/src/provider_terminal apps/server/src/production/relay.rs
git add apps/server/src/provider_terminal/claude.rs apps/server/src/provider_terminal/codex.rs apps/server/src/provider_terminal/opencode.rs apps/server/src/production/relay.rs
git commit -m "test(provider): synchronize parallel process fixtures"
```

Expected search result: no module/global process test lock remains in these files.

### Task 6: Remove remaining server broad-lock callers and harden singleton cleanup

**Files:**
- Modify: `apps/server/src/process/mod.rs`
- Modify: `apps/server/src/lifecycle.rs`
- Modify: `apps/server/src/production/control.rs`
- Modify: `apps/server/src/production/runtime.rs`
- Modify: `apps/server/src/production/server_terminal.rs`
- Modify: `apps/server/src/logging.rs`
- Modify: `apps/server/src/provider_terminal/model.rs`
- Modify: `apps/server/src/terminal/manager.rs`
- Modify: `apps/server/src/provider_usage/codex_backend.rs`

**Interfaces:**
- Consumes: migrated sandbox/process/provider fixtures from Tasks 1–5.
- Produces: zero `EXTERNAL_PROCESS_TEST_LOCK` definitions/usages and cancellation-safe named singleton ownership.

- [ ] **Step 1: Add abort/panic RED tests for each retained singleton**

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn observer_worker_slot_is_reusable_after_aborted_owner() {
    let owner = start_test_observer_worker().await;
    owner.abort();
    owner.wait_reaped().await;
    let replacement = start_test_observer_worker().await;
    replacement.shutdown().await;
}
```

Add matching terminal callback/generation-slot cleanup tests. Logging retains only its production one-time initialization; tests use per-sandbox writers/roots.

- [ ] **Step 2: Run RED and inventory all remaining lock callers**

```bash
cargo test -p bibcode-server --lib provider_terminal::model::tests::observer_worker_slot_is_reusable_after_aborted_owner -- --exact
rg -n "EXTERNAL_PROCESS_TEST_LOCK" apps/server/src
```

- [ ] **Step 3: Remove the convoy and preserve real ownership**

Remove lock acquisitions from tests whose resources are already instance-owned. For a genuine finite production resource, retain its production semaphore/queue and test capacity, fairness, cancellation, and permit release directly. Do not replace the broad lock with another unnamed lock.

Delete the static from `process/mod.rs` only after `rg` returns no callers.

- [ ] **Step 4: Run GREEN and commit**

```bash
cargo test -p bibcode-server --lib lifecycle::tests -- --test-threads=8
cargo test -p bibcode-server --lib production::control::tests -- --test-threads=8
cargo test -p bibcode-server --lib production::runtime::tests -- --test-threads=8
cargo test -p bibcode-server --lib production::server_terminal::tests -- --test-threads=8
cargo test -p bibcode-server --lib logging::tests -- --test-threads=8
cargo test -p bibcode-server --lib provider_terminal::model::tests -- --test-threads=8
cargo test -p bibcode-server --lib terminal::manager::tests -- --test-threads=8
cargo test -p bibcode-server --lib provider_usage::codex_backend::tests -- --test-threads=8
test -z "$(rg -n 'EXTERNAL_PROCESS_TEST_LOCK|SYSTEM_PROCESS_TEST_LOCK' apps/server/src || true)"
git add apps/server/src/process/mod.rs apps/server/src/lifecycle.rs apps/server/src/production/control.rs apps/server/src/production/runtime.rs apps/server/src/production/server_terminal.rs apps/server/src/logging.rs apps/server/src/provider_terminal/model.rs apps/server/src/terminal/manager.rs apps/server/src/provider_usage/codex_backend.rs
git commit -m "test(server): remove global process test convoy"
```

### Task 7: Make desktop native fixtures instance-owned

**Files:**
- Create: `apps/desktop/src-tauri/src/test_support.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/src/backend.rs`
- Modify: `apps/desktop/src-tauri/src/tailscale.rs`
- Modify: `apps/desktop/src-tauri/src/updates.rs`

**Interfaces:**
- Produces: private `WslCommandResolver: Send + Sync`, `SystemWslCommandResolver`, and test resolver instances owned by `BackendSupervisor`.
- Produces: desktop `FixtureEvent` with the same `AtomicU64`/`Notify` checkpoint contract as Task 1; the server's `#[cfg(test)]` module is not exported across crates.
- Removes: `WSL_COMMAND_OVERRIDE`, `WSL_SERVER_BINARY_OVERRIDE`, and their global guard.

- [ ] **Step 1: Write the RED instance-isolation test**

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn supervisors_keep_distinct_wsl_resolvers() {
    let left = BackendSupervisor::with_wsl_resolver(Arc::new(TestWslCommandResolver::new("left-wsl")));
    let right = BackendSupervisor::with_wsl_resolver(Arc::new(TestWslCommandResolver::new("right-wsl")));
    let (left_plan, right_plan) = tokio::join!(
        left.test_wsl_plan("Ubuntu"),
        right.test_wsl_plan("Ubuntu"),
    );
    let BackendLaunchTarget::ExternalProcess { args: left_args, .. } =
        left_plan.expect("left plan").target
    else {
        panic!("left resolver must produce a WSL process plan");
    };
    let BackendLaunchTarget::ExternalProcess { args: right_args, .. } =
        right_plan.expect("right plan").target
    else {
        panic!("right resolver must produce a WSL process plan");
    };
    assert!(left_args.iter().any(|arg| arg == "/left-wsl/bibcode"));
    assert!(right_args.iter().any(|arg| arg == "/right-wsl/bibcode"));
}
```

- [ ] **Step 2: Run RED**

```bash
cargo test -p bibcode-desktop --lib backend::tests::supervisors_keep_distinct_wsl_resolvers -- --exact
```

Expected: compile failure while WSL commands remain global free functions/statics.

- [ ] **Step 3: Implement instance-owned resolver and desktop fixture events**

```rust
trait WslCommandResolver: Send + Sync {
    fn command(&self) -> std::process::Command;
    fn server_binary_candidates(&self) -> Result<Vec<PathBuf>, String>;
}
```

`BackendSupervisor::new` installs `SystemWslCommandResolver`; the test-only constructor accepts an `Arc<dyn WslCommandResolver>`. Thread the resolver through WSL plan resolution without a mutable static.

Use desktop sandbox roots, retained listeners, and positive request/response events in backend, Tailscale, and update fixtures. Keep production deadlines unchanged; test bounds are outer watchdogs only.

- [ ] **Step 4: Run GREEN, search, and commit**

```bash
cargo test -p bibcode-desktop --lib backend::tests -- --test-threads=8
cargo test -p bibcode-desktop --lib tailscale::tests -- --test-threads=8
cargo test -p bibcode-desktop --lib updates::tests -- --test-threads=8
test -z "$(rg -n 'WSL_COMMAND_OVERRIDE|WSL_SERVER_BINARY_OVERRIDE' apps/desktop/src-tauri/src || true)"
git add apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/src/test_support.rs apps/desktop/src-tauri/src/backend.rs apps/desktop/src-tauri/src/tailscale.rs apps/desktop/src-tauri/src/updates.rs
git commit -m "test(desktop): isolate parallel native fixtures"
```

### Task 8: Enable default Rust test threads in package and CI commands

**Files:**
- Modify: `apps/server/package.json`
- Modify: `apps/desktop/package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/ci-platform-contract.test.ts`
- Modify: `docs/operations/ci.md`
- Modify: `docs/reference/scripts.md`

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces: standard package/CI commands without `--test-threads=1`; root `vp run -r test` remains concurrent.

- [ ] **Step 1: Write the RED CI/script contract**

```ts
expect(serverPackage.scripts.test).toBe(
  "node ../../scripts/run-msvc-x64.mjs cargo test -p bibcode-server -j 2",
)
expect(desktopPackage.scripts.test).toBe(
  "node ../../scripts/run-msvc-x64.mjs cargo test -p bibcode-desktop -j 2",
)
expect(ciWorkflow).toContain("cargo test --workspace -j 2")
expect(ciWorkflow).not.toContain("--test-threads=1")
```

- [ ] **Step 2: Run RED**

```bash
vp test run scripts/ci-platform-contract.test.ts
```

Expected: failure because both package scripts and CI still force one test thread.

- [ ] **Step 3: Apply the exact runner changes and document them**

Use:

```json
"test": "node ../../scripts/run-msvc-x64.mjs cargo test -p bibcode-server -j 2"
```

```json
"test": "node ../../scripts/run-msvc-x64.mjs cargo test -p bibcode-desktop -j 2"
```

and:

```yaml
- name: Rust workspace tests
  run: cargo test --workspace -j 2
```

Document that `vp run test` keeps package tasks concurrent and Rust now uses default harness threads. Exact subprocess tests may still pass `--exact` and `--test-threads=1` inside their isolated child process because that child intentionally owns process-global state.

- [ ] **Step 4: Run GREEN and commit**

```bash
vp test run scripts/ci-platform-contract.test.ts
cargo test -p bibcode-server -j 2
cargo test -p bibcode-desktop -j 2
git add apps/server/package.json apps/desktop/package.json .github/workflows/ci.yml scripts/ci-platform-contract.test.ts docs/operations/ci.md docs/reference/scripts.md
git commit -m "test(ci): enable parallel Rust harnesses"
```

### Task 9: Concurrent soak, performance evidence, and exposed-race discipline

**Files:**
- Review: all files changed by Tasks 1–8.
- No planned source modifications. A newly exposed race blocks this task and requires a new task-specific plan amendment before editing.

**Interfaces:**
- Produces: three consecutive parallel graph passes, default-thread workspace pass, resource/leak evidence, and final static evidence.

- [ ] **Step 1: Run the server and desktop package tests concurrently**

```bash
vp run --filter bibcode test & server_pid=$!
vp run --filter @bibcode/desktop test & desktop_pid=$!
wait "$server_pid"
wait "$desktop_pid"
```

Expected: both exit zero with default Rust test threads.

- [ ] **Step 2: Run the complete graph three times**

```bash
for run in 1 2 3; do
  vp run test
done
```

Expected: all three runs exit zero. Record each wall-clock duration, maximum active fixture/child count, named resource-admission waits, and final leaked resource count in the task report.

- [ ] **Step 3: Triage any newly exposed failure before editing**

For the historically rotating process/RPC fixtures, isolate with the matching exact command:

```bash
cargo test -p bibcode-server --lib provider_terminal::claude::tests::system_probe_streams_large_output_into_fixed_bounds -- --exact --nocapture
cargo test -p bibcode-server --lib provider_terminal::codex::tests::system_probe_streams_large_output_into_fixed_bounds -- --exact --nocapture
cargo test -p bibcode-server --lib provider_terminal::opencode::tests::invalid_helper_readiness_is_killed_and_reaped_before_error_returns -- --exact --nocapture
cargo test -p bibcode-server --lib production::git_vcs::tests::native_git_vcs_service_covers_repository_lifecycle_and_validation_paths -- --exact --nocapture
cargo test -p bibcode-server --lib source_control::pull_request::tests::provider_cli_flows_cover_github_gitlab_and_azure_resolution_and_creation -- --exact --nocapture
cargo test -p bibcode-desktop --lib backend::tests::in_process_desktop_runtime_serves_production_rpc_domains -- --exact --nocapture
```

Run only the command matching the observed failure. For any different failure, stop Task 9 as `BLOCKED`, record its exact name/output, and add a task-specific plan amendment before changing source.

Classify it:

- stale publication, lock ordering, duplicate ownership, or lost cancellation: production defect; add a barrier-controlled regression in the owning module;
- shared environment/CWD/static/path/port or incomplete readiness: fixture defect; move it to the sandbox;
- bounded capacity: assert named finite admission, fairness, cancellation, and recovery.

Do not fix a failure with a blanket timeout increase.

- [ ] **Step 4: Run final workspace/static gates**

```bash
cargo test --workspace -j 2
vp check
vp run typecheck
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
git diff --check
git status --short
```

Expected: every command exits zero; status shows no unintended, generated, dependency, `.repos`, `.codegraph`, or ignored evidence changes.

- [ ] **Step 5: Complete the evidence-only task**

Task 9 produces no commit. If all commands pass, record the timing/concurrency/leak evidence and proceed to final review. If a race appears, stop with the classification and exact reproduction so a new scoped implementation task can be reviewed before execution.
