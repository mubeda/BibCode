# Task 9F Desktop Update Instance Ownership Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:systematic-debugging before superpowers:test-driven-development.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Diagnose and repair the 16 desktop library failures exposed by the
loaded Task 9 graph so update capability, configuration, requests, scheduler
events, and operation lifetimes remain owned by each desktop application
instance under default parallel Rust tests.

**Architecture:** First minimize the observed bridge metadata, update
availability, operation-readiness, and scheduler failures without changing
source. Preserve the desktop updater and its Tauri security boundary; repair the
standard package launcher so an explicitly isolated macOS Cargo test target is
represented by its canonical filesystem path before the test process starts.
Keep fixture events, listeners, request release channels, background tasks, and
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
- Do not bypass Tauri's macOS starting-binary symlink defense or inject a fake
  update capability into desktop application code.
- Use strict vertical RED-to-GREEN cycles and stop if a different failure
  appears.

## Root-Cause Amendment: Canonical Test-Binary Launch Identity

The preserved Task 9E graph binary reproduced the identical 270/16 failure
split outside the graph. On macOS, `tauri_utils::platform::current_exe` rejects
that binary because its launch path has `/tmp` as a symlink ancestor. The graph
supplied `CARGO_TARGET_DIR=/tmp/bibcode-task9e-target`; the standard desktop
package command passed it unchanged through
`scripts/run-msvc-x64.mjs cargo test`. Every updater call therefore failed
before HTTP, and the three fixture-event waits were downstream symptoms of no
request owner starting.

An application-level executable override is not viable because
`tauri-plugin-updater::UpdaterBuilder::build` eagerly resolves Tauri's secured
starting binary before honoring the explicit executable path. Enabling Tauri's
dangerous macOS symlink feature would weaken production security. The revised
owner is the standard Cargo-test launcher: on macOS only, when an explicit
`CARGO_TARGET_DIR` is configured for `cargo test`, create that intended target
directory and pass its filesystem-canonical path to Cargo. Other platforms and
non-test commands remain unchanged.

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

### Task 2: Canonicalize the macOS Cargo-test launch identity

**Files:**

- Modify: `scripts/run-msvc-x64.mjs`
- Test: `scripts/run-msvc-x64.test.mjs`
- Modify: `docs/reference/scripts.md`

**Interfaces:**

- Preserves: all updater implementation, security features, endpoints,
  signature checks, bridge commands, and production runtime paths.
- Produces: `canonicalizeMacosCargoTestTarget(args, env, options)`, which uses
  the same explicit target directory through its real path on macOS and leaves
  every other command/platform unchanged.

- [ ] **Step 1: Write the launcher contract RED**

Call `runMsvcX64(["cargo", "test", ...])` with macOS and
`CARGO_TARGET_DIR=/tmp/bibcode-task9f-target`. Require directory creation,
real-path resolution to `/private/tmp/bibcode-task9f-target`, and only that
canonical value in the spawned Cargo environment. Verify RED because the
wrapper currently forwards `/tmp/...` unchanged.

- [ ] **Step 2: Implement the smallest canonicalization seam**

For macOS `cargo test` with a non-empty explicit target, resolve relative paths
against the wrapper working directory, create the directory recursively, and
call `realpath`. Return a copied environment with that canonical target. Do not
copy a binary, mutate CWD or the parent environment, or normalize an implicit
Cargo target.

- [ ] **Step 3: Prove unrelated commands remain unchanged**

Add cases for Windows/Linux, `cargo check`, a non-Cargo command, and an unset
target. Require no filesystem calls and unchanged environment values. Document
the narrow macOS Cargo-test rule.

- [ ] **Step 4: Run GREEN in the original failing target**

Rebuild through the wrapper using the original
`CARGO_TARGET_DIR=/tmp/bibcode-task9e-target`, then run the exact bridge failure
and all update tests. Confirm the test binary starts through the canonical path
and all original failures are green. If any event wait remains, return to Task
1 rather than changing a timeout.

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
