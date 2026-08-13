# Task 9F Desktop Update Instance Ownership Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:systematic-debugging before superpowers:test-driven-development.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Diagnose and repair the 16 desktop library failures exposed by the
loaded Task 9 graph so update capability, configuration, requests, scheduler
events, and operation lifetimes remain owned by each desktop application
instance under default parallel Rust tests.

**Architecture:** Treat `DesktopUpdateManager` and its owning Tauri application
as the update-runtime boundary. First minimize the observed bridge metadata,
update availability, operation-readiness, and scheduler failures without
changing source. If ambient Tauri mock/plugin configuration crosses application
instances, replace that ambient dependency in tests with a private
instance-owned update capability/source carried by `DesktopUpdateManager`, while
production continues to resolve and execute the configured Tauri updater. Keep
fixture events, listeners, request release channels, background tasks, and
operation guards attached to the exact manager/application that created them.

**Tech Stack:** Rust 2024, Tokio multi-thread tests and paused time, Tauri 2
mock runtime, `tauri-plugin-updater`, fixture-owned loopback HTTP servers,
Vite+ concurrent package graph.

## Global Constraints

- Baseline is clean commit `be33863d` after the reviewed Task 9E repair.
- The observed graph result is 270 passed and 16 failed in the desktop library:
  one bridge metadata assertion, twelve update capability/action assertions,
  and three scheduler/readiness waits.
- Do not add global locks, mutable process environment or CWD, sleeps, yields,
  polling, suite serialization, harness-thread reduction, timeout widening, or
  weakened assertions.
- Do not change updater release endpoints, signature verification, install
  protection, production check cadence, public bridge shapes, or production
  update availability policy.
- Update capability/configuration, fixture events, listeners, request-release
  channels, operation tasks, and scheduler tasks must be instance-owned.
- A test capability may be injected only through a private desktop/test seam;
  it must not infer availability from ambient host configuration or another
  Tauri application.
- Use strict vertical RED-to-GREEN cycles and stop if a different failure
  appears.

---

### Task 1: Reproduce, minimize, and classify the desktop failure cluster

**Files:**

- Inspect/Test: `apps/desktop/src-tauri/src/bridge.rs`
- Inspect/Test: `apps/desktop/src-tauri/src/updates.rs`
- Inspect: `apps/desktop/src-tauri/src/lib.rs`
- Inspect: `apps/desktop/src-tauri/src/test_support.rs`
- Review: `apps/desktop/src-tauri/Cargo.toml`
- Review: `apps/desktop/src-tauri/tauri.conf.json`
- Review: `apps/desktop/src-tauri/tauri.release.conf.json`
- Append: `.superpowers/sdd/2026-08-11-parallel-rust-test-sandboxes/task-9-report.md`

**Interfaces:**

- Consumes: `desktop_bridge_get_bridge_metadata`, `DesktopUpdateManager`,
  `UpdaterExt`, `run_background_update_checks`, and `FixtureEvent`.
- Produces: one written root-cause classification naming the exact state owner
  that supplies `enabled = false`, the exact last readiness/scheduler event for
  each timeout, and whether the 16 failures are one configuration-owner defect
  or multiple independent defects.

- [ ] **Step 1: Run only the 16 exact observed failures**

Run the exact bridge metadata test, then each exact update test reported in
`/tmp/bibcode-task9e-graph.log`. Record result, wall time, updater error/value,
and last positive event. Do not run the whole module until every exact command
is classified.

- [ ] **Step 2: Reproduce the smallest parallel interference set**

Use the already-built desktop library test binary to run the bridge metadata
test with one enabled-update test, then grow only to the smallest filter or
explicit test set that changes either app from enabled to disabled. Repeat at
default, 8, and 12 harness threads. A lone pass is only evidence of
interference, not correctness.

- [ ] **Step 3: Trace the value and lifecycle owners**

Trace `AppHandle::updater()` backward through the plugin-managed configuration
for both empty-endpoint and release/test-endpoint applications. For scheduler
failures, trace timer-armed generation, check-owner spawn/join, HTTP request
entry, operation-guard publication, completion generation, next timer arm, and
task abort/join. Compare the Task 7 fixture-event changes at `8327a553` with the
current owners.

- [ ] **Step 4: Rank and test falsifiable hypotheses**

Test these in order without production edits:

1. another mock application can replace or shadow the updater state observed by
   an existing application;
2. an enabled test application is built with empty endpoints because capability
   comes from ambient build/plugin configuration rather than its own fixture;
3. the three waits are secondary consequences of a disabled updater and no
   request, rather than independent lost wakeups;
4. a scheduler or request owner is detached before its positive event even when
   updater capability remains enabled.

Record the prediction and observation for each probe. Do not proceed to a fix
until one root cause is proven.

### Task 2: Make update capability and source instance-owned

**Files:**

- Modify/Test: `apps/desktop/src-tauri/src/updates.rs`
- Modify/Test only if bridge construction requires it:
  `apps/desktop/src-tauri/src/bridge.rs`
- Modify only if application ownership changes:
  `apps/desktop/src-tauri/src/lib.rs`
- Modify only if a documented invariant changes:
  `docs/architecture/overview.md`

**Interfaces:**

- Preserves: `DesktopUpdateManager::new()` as the production constructor and all
  existing bridge command inputs/outputs.
- Produces: a private, immutable update capability/source owned by each
  `DesktopUpdateManager`; test construction supplies its own enabled or disabled
  source explicitly, while production delegates to the updater configured on
  that exact Tauri application.
- Produces: an enabled/disabled two-application regression where both
  applications remain alive and retain their own metadata and action results
  concurrently.

- [ ] **Step 1: Write the cross-instance capability RED**

Add one behavioral regression that constructs an explicitly disabled
application and an explicitly enabled loopback-update application, keeps both
alive, and calls metadata/state/check through each instance in both creation
orders. Require the disabled instance to remain disabled and the enabled
instance to issue exactly one request and remain enabled. Run it at 8 and 12
threads and verify it fails for the observed wrong owner/value.

- [ ] **Step 2: Implement the smallest private ownership seam**

Move the decision and updater construction behind an immutable source owned by
`DesktopUpdateManager`. The production source must call the configured Tauri
updater for the same application handle. The test source must carry the exact
enabled/disabled capability and endpoint/signature material for its own
application; it may not read environment variables, process CWD, a static, or
another app's plugin state. Keep real updater HTTP and signature behavior in the
existing integration tests.

- [ ] **Step 3: Route metadata and actions through the same owner**

Make bridge metadata, `state`, `check_for_update`, `download_update`, install
admission, and background checks derive capability from the same manager-owned
source. Do not create a second feature-flag truth or convert genuine updater
construction errors into disabled state.

- [ ] **Step 4: Run GREEN before addressing any remaining timeout**

Run the new cross-instance regression, the exact metadata failure, and every
exact update capability/action failure. If a readiness/scheduler timeout
remains while capability is enabled, stop and return to Task 1 for a separately
proven lifecycle cause.

### Task 3: Close any independently proven scheduler/readiness ownership gap

**Files:**

- Modify/Test: `apps/desktop/src-tauri/src/updates.rs`
- Modify/Test only if the event primitive is itself defective:
  `apps/desktop/src-tauri/src/test_support.rs`

**Interfaces:**

- Preserves: 15-second startup delay, 30-minute background interval, real
  updater request semantics, and operation cancellation behavior.
- Produces: one joined scheduler owner and one joined operation owner whose
  ordered fixture generations prove timer arm, request entry, completion,
  re-arm, cancellation cleanup, and retry without sleeping or widening bounds.

- [ ] **Step 1: Write one deterministic RED for the proven gap**

Only if Task 2 leaves a timeout, add the smallest test at the real seam. Capture
the event checkpoint before spawning the owner, retain its `JoinHandle`, and
assert the owner result alongside the expected event so an early error cannot
be hidden behind an event timeout.

- [ ] **Step 2: Implement exact ownership**

Retain the scheduler/operation task until its completion or explicit
cancellation has been joined. Publish completion only after the underlying
check owner returns, and arm the next timer before publishing any state that
allows the test/application to proceed. Keep each event on the exact manager.

- [ ] **Step 3: Verify paused-time and cancellation behavior**

Run the three formerly timing-out exact tests, the cancellation pair, and the
overlap pair. Require the real HTTP listener threads and async owners to join and
the exact request counts to match.

### Task 4: Verify the parallel desktop contract and review

**Files:**

- Review: Task 9F diff from `be33863d` through the final scoped commit.
- Append: `.superpowers/sdd/2026-08-11-parallel-rust-test-sandboxes/task-9-report.md`
- Append: `.superpowers/sdd/2026-08-11-parallel-rust-test-sandboxes/progress.md`

**Interfaces:**

- Produces: exact, module, default/8/12, full desktop, one replacement workspace
  graph, static-gate, no-survivor, and independent-review evidence.

- [ ] **Step 1: Run focused and module parallel coverage**

```bash
cargo test -p bibcode-desktop --lib bridge::tests::bridge_metadata_reports_version_and_feature_flags -- --exact --nocapture
cargo test -p bibcode-desktop --lib updates::tests -- --nocapture
cargo test -p bibcode-desktop --lib updates::tests -- --test-threads=8 --nocapture
cargo test -p bibcode-desktop --lib updates::tests -- --test-threads=12 --nocapture
cargo test -p bibcode-desktop --lib bridge::tests -- --test-threads=8 --nocapture
cargo test -p bibcode-desktop --lib backend::tests -- --test-threads=8 --nocapture
```

- [ ] **Step 2: Run the full desktop suite**

```bash
cargo test -p bibcode-desktop -j 2
cargo test -p bibcode-desktop -j 2 -- --test-threads=8
cargo test -p bibcode-desktop -j 2 -- --test-threads=12
```

- [ ] **Step 3: Run one replacement graph under an isolated target**

Run `vp run test` once with the Task 9 process sampler and an isolated Cargo
target. Stop on a different failure. Record package results, test/child-process
high-water counts, updater fixture requests, cleanup diagnostics, temporary
roots, and final survivors.

- [ ] **Step 4: Run repository and anti-serialization gates**

```bash
cargo fmt --all --check
cargo clippy -p bibcode-desktop --all-targets -- -D warnings
vp check
vp run typecheck
git diff --check
test -z "$(rg -n 'serial_test|--test-threads=1|yield_now|set_current_dir|set_var|remove_var' apps/desktop/src-tauri/src || true)"
git status --short
```

- [ ] **Step 5: Obtain independent read-only review**

Review for duplicate capability truth, production updater-policy drift,
test-only behavior leaking into production, ambient plugin/config dependence,
detached tasks/listeners, lost event generations, timeout masking, unjoined
owners, global locks, serialization, and assertions weakened from the observed
failures. Address every Critical or Important finding before Task 9 resumes.
