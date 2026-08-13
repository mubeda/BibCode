# Task 9G Claude Terminal Load Readiness Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Claude dual-probe high-output regression observe its real subprocess owners reliably under parallel workspace load while retaining the two-second production probe timeout and proving termination and reap behavior.

**Architecture:** `apps/server/src/provider_terminal/claude.rs` remains the owner of Claude capability-probe policy and keeps the existing production timeout, cleanup timeout, output cap, and admission behavior. The high-output pair alone receives one private `cfg(test)` absolute integration deadline and a spawn observer through the existing supervised-process test seam, then verifies positive body, stream, PID, owner-return, termination, and reap milestones. The unchanged default runner receives a dedicated real-child timeout regression, and watchdog/error paths must retain their exact owner until cleanup completes.

**Tech Stack:** Rust, Tokio multi-thread tests, `process-wrap`, Unix subprocess fixtures, Cargo/Vite+ workspace tooling, CodeGraph.

## Global Constraints

- Do not change the production Claude probe timeout, cleanup timeout, output capacity, concurrency capacity, provider protocol, or public API.
- Do not add test serialization, sleeps, `yield_now`, process-global locks, or process-global PATH/CWD mutation.
- Use one absolute integration deadline for the two high-output probe owners; do not convert it to a duration that can re-anchor the deadline.
- Every spawned fixture process must have one retained owner until positive process completion or bounded kill-and-reap completion.
- Stop without another graph run or unrelated source edit if any verification exposes a different failure.

---

### Task 1: Diagnose and repair Claude probe ownership observation

**Files:**
- Modify: `apps/server/src/provider_terminal/claude.rs:1726-1776`
- Modify: `apps/server/src/provider_terminal/claude.rs:1936-2011`
- Update evidence: `.superpowers/sdd/2026-08-11-parallel-rust-test-sandboxes/task-9-report.md`

**Interfaces:**
- Consumes: `crate::process::supervised::run_supervised_with_spawn_observer_until`, `SupervisedRunRequest`, `TestSandbox`, and the existing Unix process-existence/reap assertions established by the Codex terminal-load repair.
- Produces: a private `cfg(test)` Claude probe fixture that publishes the exact spawned PID and uses a precomputed `tokio::time::Instant`; production still calls `run_supervised` with the existing two-second timeout.

- [ ] **Step 1: Reproduce the exact failure boundary before editing source**

Run the exact test alone from the already-built server test binary or Cargo target:

```bash
cargo test -p bibcode-server --lib provider_terminal::claude::tests::two_claude_probes_bound_both_output_streams_in_parallel -- --exact --nocapture
```

Then run the already-built module under bounded external CPU/process load, without compiling in parallel. Record whether the first missing milestone is spawn/PID publication, fixture body entry, stdout completion, stderr completion, owner return, or reap.

```bash
server_test_binary=$(find target/debug/deps -type f -perm +111 -name 'bibcode_server-*' -print | head -n 1)
for index in 1 2 3 4 5 6; do
  "$server_test_binary" 'provider_terminal::claude::tests::' --test-threads=12 --nocapture &
done
"$server_test_binary" 'provider_terminal::claude::tests::two_claude_probes_bound_both_output_streams_in_parallel' --exact --nocapture
wait
```

- [ ] **Step 2: Add the high-output and default-timeout regression contracts first**

Extend `ClaudeBoundedProbeFixture` so the script exits nonzero if either `dd` fails and publishes separate body-entry, stdout-complete, stderr-complete, and body-complete files. Give the runner a `cfg(test)` spawn observer that atomically publishes the exact PID. Change only the high-output pair to construct both owners from one precomputed 15-second `tokio::time::Instant`, and assert literal input/output byte counts, owner success, distinct PIDs, PID absence, and `waitpid(WNOHANG) == ECHILD`.

Add a real-child regression named `default_system_probe_timeout_terminates_and_reaps_the_owned_process`. It must instantiate `SystemClaudeCapabilityProbeRunner::default()`, assert behavior at the unchanged two-second boundary with a never-completing child, and prove exact PID termination plus `ECHILD` after the owner returns.

Add an owner-error regression whose executable does not exist. It must prove the retained owner reports the spawn error immediately rather than letting an outer observation watchdog replace it.

Run each new or strengthened test against the pre-repair implementation and retain the expected RED: the high-output fixture lacks the required private deadline/PID/stream milestones, while the timeout and error tests lack the spawn-observer ownership evidence.

- [ ] **Step 3: Implement the smallest test-only supervised seam routing**

Keep `SystemClaudeCapabilityProbeRunner::default()` at `Duration::from_secs(2)`. Under `cfg(test)`, allow the fixture runner to carry an optional absolute `tokio::time::Instant` and spawn observer. Route that case through `run_supervised_with_spawn_observer_until`; route normal tests and all production builds through `run_supervised` exactly as before.

If an outer integration watchdog is required around a retained Tokio owner, it must race the owner result first, report an owner error immediately, and on expiry abort and join that owner before returning. Cleanup completion must be observed after the exact PID has been published, and the watchdog path must prove PID absence plus `ECHILD`.

- [ ] **Step 4: Run focused GREEN and parallel module coverage**

```bash
cargo test -p bibcode-server --lib provider_terminal::claude::tests::two_claude_probes_bound_both_output_streams_in_parallel -- --exact --nocapture
cargo test -p bibcode-server --lib provider_terminal::claude::tests::default_system_probe_timeout_terminates_and_reaps_the_owned_process -- --exact --nocapture
cargo test -p bibcode-server --lib provider_terminal::claude::tests::probe_fixture_reports_owner_failure_before_observation_watchdog -- --exact --nocapture
cargo test -p bibcode-server --lib provider_terminal::claude::tests:: -- --nocapture
cargo test -p bibcode-server --lib provider_terminal::claude::tests:: -- --test-threads=8 --nocapture
cargo test -p bibcode-server --lib provider_terminal::claude::tests:: -- --test-threads=12 --nocapture
```

Expected: every command exits zero; the exact pair retains two distinct owners and both bounded streams, while the default runner still kills and reaps at its production timeout.

- [ ] **Step 5: Reproduce the loaded seam using only the already-built module**

Run multiple complete Claude modules concurrently with the exact dual-probe target under bounded CPU/process load. Do not compile concurrently. Record the high-output test duration, maximum live matching fixture count, every observed PID, owner completion, PID absence, `ECHILD`, and a final zero-survivor process snapshot.

```bash
server_test_binary=$(find target/debug/deps -type f -perm +111 -name 'bibcode_server-*' -print | head -n 1)
for index in 1 2 3 4 5 6; do
  "$server_test_binary" 'provider_terminal::claude::tests::' --test-threads=12 --nocapture &
done
"$server_test_binary" 'provider_terminal::claude::tests::two_claude_probes_bound_both_output_streams_in_parallel' --exact --nocapture
wait
pgrep -af 'bibcode_server-|large-claude-probe|hung-claude-probe' || true
```

- [ ] **Step 6: Run static and package gates, then commit the scoped repair**

```bash
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
vp check
vp run typecheck
git diff --check
git status --short
```

Expected: every command exits zero and the diff contains only the scoped Claude source/tests plus Task 9 evidence. Commit the implementation separately from this plan amendment.

- [ ] **Step 7: Run exactly one isolated replacement graph**

Create a fresh explicit Cargo target under the native canonical temporary-directory identity, then run:

```bash
CARGO_TARGET_DIR=/private/tmp/bibcode-task9g-graph-target vp run test
```

Expected: the original Claude exact passes inside the loaded graph. If a different test fails, stop immediately, retain the raw log and process/leak snapshot, and report the new blocker without rerunning or editing it.

- [ ] **Step 8: Obtain independent read-only review**

Review the plan commit through the final repair commit for: production-policy drift, deadline re-anchoring, detached owner/watchdog paths, incomplete PID publication, false-positive output assertions, missing `ECHILD`, serialization/global mutation, and surviving processes. Address every Critical or Important finding test-first; re-run the scoped gates and record the final verdict.
