# Provider Terminal Timeout Test Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Claude bounded-output and Codex cancellation tests reliable under the complete workspace test graph without changing production failure deadlines.

**Architecture:** Keep the existing process-supervision implementations and production timeout constants. Give the private Claude system runner an injectable timeout with the existing two-second value as its default, and increase only the Codex test's positive-start observation watchdog.

**Tech Stack:** Rust 2024, Tokio process supervision, Cargo test, Vite+ workspace gates.

## Global Constraints

- The Claude production probe timeout remains exactly two seconds.
- The Codex production helper readiness timeout remains exactly three seconds.
- The Codex production helper reap timeout remains exactly two seconds.
- No public API, protocol, persistence, provider behavior, or dependency changes.
- Tests must continue exercising real child processes, output draining, cancellation, and reap ownership.

---

### Task 1: Decouple the Claude bounded-output test from the production deadline

**Files:**
- Modify: `apps/server/src/provider_terminal/claude.rs:480-490`
- Modify: `apps/server/src/provider_terminal/claude.rs:1723-1756`
- Test: `apps/server/src/provider_terminal/claude.rs:1935-1959`

**Interfaces:**
- Consumes: `run_supervised(SupervisedRunRequest, &CancellationToken)`.
- Produces: private `SystemClaudeCapabilityProbeRunner::with_timeout(Duration)` while `Default` preserves the two-second production timeout.

- [ ] **Step 1: Retain the observed RED evidence**

The existing `vp run test` failure is the regression proof:

```text
provider_terminal::claude::tests::system_probe_streams_large_output_into_fixed_bounds
large probe: "Claude capability probe failed: Timeout"
```

The exact test passes when isolated, proving the failure is contention-sensitive rather than a deterministic functional error.

- [ ] **Step 2: Add the minimal private timeout seam**

Replace the unit runner with a private timeout-bearing runner whose default is unchanged:

```rust
#[derive(Debug)]
struct SystemClaudeCapabilityProbeRunner {
    timeout: Duration,
}

impl SystemClaudeCapabilityProbeRunner {
    const fn with_timeout(timeout: Duration) -> Self {
        Self { timeout }
    }
}

impl Default for SystemClaudeCapabilityProbeRunner {
    fn default() -> Self {
        Self::with_timeout(Duration::from_secs(2))
    }
}
```

Use `self.timeout` in `SupervisedRunRequest`. Replace production construction
with `SystemClaudeCapabilityProbeRunner::default()` and construct only the
bounded-output test with `Duration::from_secs(10)`.

- [ ] **Step 3: Verify the focused behavior**

Run:

```bash
cargo test -p bibcode-server --lib provider_terminal::claude::tests::system_probe_streams_large_output_into_fixed_bounds -- --exact --nocapture
```

Expected: PASS; stdout and stderr remain bounded by
`CLAUDE_PROBE_OUTPUT_LIMIT`.

- [ ] **Step 4: Verify the Claude provider-terminal module**

Run:

```bash
cargo test -p bibcode-server --lib provider_terminal::claude::tests:: -- --nocapture
```

Expected: every Claude provider-terminal unit test passes.

- [ ] **Step 5: Commit the Claude change**

```bash
git add apps/server/src/provider_terminal/claude.rs
git commit -m "test(provider): decouple Claude probe fixture deadline"
```

### Task 2: Give the Codex cancellation test an observation-only failure bound

**Files:**
- Modify/Test: `apps/server/src/provider_terminal/codex.rs:2382-2439`

**Interfaces:**
- Consumes: the real `SystemCodexHelperLauncher`, helper supervisor, PID marker, cancellation token, and child-reap path.
- Produces: no production interface; only a longer outer test watchdog.

- [ ] **Step 1: Retain the observed RED evidence**

The existing `vp run test` failure is the regression proof:

```text
provider_terminal::codex::tests::cancelling_helper_start_before_readiness_still_reaps_the_child
helper process started before cancellation: Elapsed(())
```

The exact test passes when isolated. The two-second outer watchdog therefore
measures host scheduling, not the cancellation/reap contract.

- [ ] **Step 2: Increase only the positive-start observation watchdog**

Change the timeout around the PID-marker polling loop:

```rust
tokio::time::timeout(Duration::from_secs(10), async {
    // Existing select loop remains unchanged.
})
```

Do not change `CODEX_HELPER_READY_TIMEOUT`, `CODEX_HELPER_REAP_TIMEOUT`, or the
post-cancellation process-exit assertions.

- [ ] **Step 3: Verify the focused behavior**

Run:

```bash
cargo test -p bibcode-server --lib provider_terminal::codex::tests::cancelling_helper_start_before_readiness_still_reaps_the_child -- --exact --nocapture
```

Expected: PASS; dropping the in-flight start still cancels and reaps the real
helper child.

- [ ] **Step 4: Verify the Codex provider-terminal module**

Run:

```bash
cargo test -p bibcode-server --lib provider_terminal::codex::tests:: -- --nocapture
```

Expected: every Codex provider-terminal unit test passes.

- [ ] **Step 5: Commit the Codex change**

```bash
git add apps/server/src/provider_terminal/codex.rs
git commit -m "test(provider): bound Codex startup observation separately"
```

### Task 3: Verify the integrated result

**Files:**
- Review: `apps/server/src/provider_terminal/claude.rs`
- Review: `apps/server/src/provider_terminal/codex.rs`

**Interfaces:**
- Consumes: the changes from Tasks 1 and 2.
- Produces: final evidence that the workspace graph is green without production deadline changes.

- [ ] **Step 1: Run repeated focused process tests**

Run each exact test five times:

```bash
for iteration in 1 2 3 4 5; do
  cargo test -p bibcode-server --lib provider_terminal::claude::tests::system_probe_streams_large_output_into_fixed_bounds -- --exact
  cargo test -p bibcode-server --lib provider_terminal::codex::tests::cancelling_helper_start_before_readiness_still_reaps_the_child -- --exact
done
```

Expected: ten focused executions pass.

- [ ] **Step 2: Run the complete workspace test graph**

```bash
vp run test
```

Expected: all workspace graph tasks pass, including the full server library.

- [ ] **Step 3: Run static gates**

```bash
vp check
vp run typecheck
cargo fmt --all --check
cargo clippy -p bibcode-server --all-targets -- -D warnings
```

Expected: every command exits zero. Existing finite-number suggestions remain non-errors.

- [ ] **Step 4: Review final scope**

```bash
git diff --check
git status --short
git diff HEAD~2..HEAD -- apps/server/src/provider_terminal/claude.rs apps/server/src/provider_terminal/codex.rs
```

Expected: only the two scoped Rust testability changes follow the design; no dependency, generated, `.repos`, `.codegraph`, or ignored evidence files are staged.
