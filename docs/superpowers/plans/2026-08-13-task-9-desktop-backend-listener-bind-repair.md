# Task 9 Desktop Backend Listener Bind Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:systematic-debugging before superpowers:test-driven-development.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the parallel desktop-test listener collision while preserving
deterministic in-process backend start, restart, shutdown, and address release.

**Architecture:** First prove whether the Task 9C failure is the known
check-then-bind gap being exercised by two independent mock desktop fixtures,
rather than a production runtime cleanup or duplicate-supervisor defect. If the
fixture diagnosis is confirmed, give each `BackendSupervisor` an instance-owned
port-selection dependency; production retains the existing preferred-port
policy, while live mock runtimes request kernel-assigned port `0` and consume the
actual listener address returned by `ServerHandle`. The real server listener
remains the lifetime owner, and the regression proves its address is unavailable
while running and released after joined shutdown.

**Tech Stack:** Rust 2024, Tokio multi-thread tests, Tauri mock runtime, Axum
server runtime, Vite+ concurrent package graph.

## Global Constraints

- Baseline is clean commit `eca178ea`.
- Do not add retries, sleeps, yields, global locks, package serialization,
  harness-thread reduction, or timeout widening.
- Do not mutate process-global `BIBCODE_PORT` in a test.
- Preserve the production preferred-port policy and every public server/desktop
  API unless diagnosis proves that an atomic pre-bound-listener transfer is
  required; stop as `NEEDS_CONTEXT` before such an architectural/public change.
- A source repair requires a deterministic RED at the owning seam before GREEN.
- The regression must positively prove listener/address ownership, restart
  publication, joined shutdown, and final address release.
- IPv4 loopback is the renderer endpoint for this local-only fixture; production
  IPv4/IPv6/LAN probing behavior remains unchanged.

---

### Task 1: Reproduce and classify the listener owner

**Files:**

- Inspect: `apps/desktop/src-tauri/src/backend.rs`
- Inspect: `apps/desktop/src-tauri/src/config.rs`
- Inspect: `apps/server/src/lifecycle.rs`
- Review: `.superpowers/sdd/2026-08-11-parallel-rust-test-sandboxes/task-9-report.md`
- Review: commit `8327a553` (`test(desktop): isolate parallel native fixtures`)

**Interfaces:**

- Consumes: `BackendSupervisor::start_default`,
  `BackendSupervisor::restart_default_if_active`, `default_launch_plans`,
  `start_managed_backend`, `ServerRuntime::start_with_ui_process_observer`, and
  `ServerHandle::local_addr`.
- Produces: a written classification naming the port chooser, listener owner,
  duplicate fixture owner if present, restart ordering, and address-release
  boundary.

- [ ] **Step 1: Run only the observed exact test once**

```bash
cargo test -p bibcode-desktop --lib backend::tests::mock_runtime_starts_restarts_and_stops_the_default_backend -- --exact --nocapture
```

Record the exact outcome. An isolated pass establishes only that the failure is
load-sensitive.

- [ ] **Step 2: Minimize with a controlled paired-load reproducer**

Use the already-built desktop library test binary to run the target test beside
the other live default-backend fixture,
`backend::tests::failed_default_backend_retains_project_data_target_and_emits_status_change`.
Capture both outcomes and the selected/bound addresses without changing any
duration. If direct binary filtering cannot run two exact names in one process,
run two binary processes concurrently so each process owns an independent mock
application and supervisor.

- [ ] **Step 3: Trace ownership backward**

Confirm whether `default_launch_plans` probes and drops a candidate before
`ServerRuntime` binds it, whether two mock fixtures select the same candidate,
whether restart joins the previous runtime before planning the replacement, and
whether the stopped `ServerHandle` releases the listener. Use test-only tagged
diagnostics only if the selected and bound addresses are otherwise ambiguous;
remove them before the RED.

- [ ] **Step 4: Classify before repair**

- Fixture defect: independent mock supervisors inherit one ambient preferred
  port policy and can claim the same dropped probe; continue with Task 2.
- Production lifecycle defect: stop does not join/release the listener before
  restart or a duplicate supervisor owns the same backend; write an owner-level
  barrier RED for that exact lifecycle before changing it.
- Architectural bind defect: correctness requires transferring an already-bound
  listener across the public desktop/server boundary; stop as `NEEDS_CONTEXT`
  with the proposed API and alternatives before editing source.

### Task 2: Give live mock runtimes an instance-owned kernel port request

**Files:**

- Modify/Test: `apps/desktop/src-tauri/src/backend.rs`
- Update only if an invariant changes: `docs/architecture/overview.md`

**Interfaces:**

- Produces: private `BackendPortResolver: Send + Sync` with a system resolver
  preserving `BIBCODE_PORT` and preferred-port behavior, plus a test resolver
  returning `0` for one supervisor instance.
- Preserves: `BackendRunConfig`, `BackendLaunchPlan`, `ServerConfig`,
  `ServerRuntime`, `ServerHandle`, readiness/shutdown deadlines, and public wire
  bootstrap shapes.

- [ ] **Step 1: Write the deterministic RED**

Change `mock_runtime_starts_restarts_and_stops_the_default_backend` to construct
its supervisor with a private fixed resolver requesting port `0`. After each
start, assert the published `BackendRunConfig.port` is non-zero and that a new
`TcpListener::bind((Ipv4Addr::LOCALHOST, port))` fails while the server owns the
address. After the final `stop` returns, bind the final address successfully and
retain that listener through the assertion. Apply the same instance-owned port
request to the malformed-store fixture's initial live default backend so the two
tests cannot share a candidate.

- [ ] **Step 2: Run RED**

```bash
cargo test -p bibcode-desktop --lib backend::tests::mock_runtime_starts_restarts_and_stops_the_default_backend -- --exact --nocapture
```

Expected: compile failure because the supervisor does not yet accept an
instance-owned backend port resolver.

- [ ] **Step 3: Implement the smallest GREEN repair**

Add the private resolver to `BackendSupervisor`, install the system resolver in
`Default`, and thread it only into `default_launch_plans`. The test resolver
returns literal `0`, so `ServerRuntime` performs the one authoritative kernel
bind and `ServerHandle::local_addr` hands the actual address back to the desktop
configuration. Do not probe a test port before binding and do not change the
production resolver.

- [ ] **Step 4: Run GREEN and mutation checks**

```bash
cargo test -p bibcode-desktop --lib backend::tests::mock_runtime_starts_restarts_and_stops_the_default_backend -- --exact --nocapture
cargo test -p bibcode-desktop --lib backend::tests::failed_default_backend_retains_project_data_target_and_emits_status_change -- --exact --nocapture
```

Confirm that bypassing the resolver, failing to replace port `0` with the
handle's address, retaining a listener after joined stop, or sharing a resolver
would fail at least one assertion.

- [ ] **Step 5: Commit the scoped RED-to-GREEN repair**

```bash
git add apps/desktop/src-tauri/src/backend.rs docs/architecture/overview.md
git commit -m "test(desktop): isolate default backend listeners"
```

Do not stage the architecture document when its invariants did not change.

### Task 3: Verify parallel lifecycle behavior and review

**Files:**

- Review: all Task 9C changes.
- Append: `.superpowers/sdd/2026-08-11-parallel-rust-test-sandboxes/task-9-report.md`

**Interfaces:**

- Produces: focused width, complete desktop, paired-package, static-gate, and
  independent review evidence.

- [ ] **Step 1: Run the backend suite at three harness widths**

```bash
cargo test -p bibcode-desktop --lib backend::tests
cargo test -p bibcode-desktop --lib backend::tests -- --test-threads=8
cargo test -p bibcode-desktop --lib backend::tests -- --test-threads=12
```

- [ ] **Step 2: Run the complete desktop package**

```bash
cargo test -p bibcode-desktop -j 2
```

- [ ] **Step 3: Run the prescribed concurrent package envelope**

```bash
vp run --filter bibcode test & server_pid=$!
vp run --filter @bibcode/desktop test & desktop_pid=$!
wait "$server_pid"
wait "$desktop_pid"
```

Both commands must exit zero. Record listener-bind output, cleanup warnings,
and final matching process/temp-root survivors; zero survivors does not waive an
incomplete-cleanup warning.

- [ ] **Step 4: Run final static and Rust gates**

```bash
vp check
vp run typecheck
cargo fmt --all --check
cargo clippy -p bibcode-desktop --all-targets -- -D warnings
git diff --check
git status --short
```

- [ ] **Step 5: Obtain independent read-only review**

Review the scoped diff for production port-policy drift, hidden serialization,
process-global state, listener lifetime leaks, restart-before-join, tests that
only probe instead of owning an address, and missing IPv4/IPv6/platform
coverage. Address every Critical or Important finding before resuming Task 9.
