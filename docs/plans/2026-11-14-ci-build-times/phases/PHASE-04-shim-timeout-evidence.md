# Phase 4: Shim timeout evidence

- Goal: a shim test timeout prints what the terminal showed, and a bounded load test on Windows arm64 records a failure rate for #367.
- Round: 1
- Depends on: none
- Owns: `apps/server/tests/windows_terminal_shims.rs`
- Must not touch: `apps/server/src/`, `.github/workflows/`, `scripts/`
- Skills: rust-best-practices (idiomatic error text and test helpers); mstack-diagnose (the flaky branch sets the run count rules)
- Read first: `research/measured_ci_and_local.md` section 5 (the failing attempt's timeline); the Windows and Linux labs notes in `docs/testing/` for the VM recipe
- Checkpoint: the Windows VM compiles and passes `cargo test -p bibcode-server --test windows_terminal_shims`, and the new self-check test shows the timeout message.

## Tasks

### Task 4.1: Print the collected output and exit state on timeout

- Satisfies: R6
- Depends on: none
- Files: modify `apps/server/tests/windows_terminal_shims.rs`
- Interfaces: `assert_shim_output` keeps its signature and its checks after the marker (exit within 10 seconds, exit code 0); produces `wait_for_marker(output, exit, marker, deadline) -> Result<String, String>` whose error text is `timed out after <n>s waiting for <marker>; output=<text>, exit=<state>`
- Skills: rust-best-practices (no unwrap that hides the evidence)
- Read first: `apps/server/tests/windows_terminal_shims.rs` lines 133 to 187
- Tier: standard
- TDD: red-green
- Done when: in the Windows VM, `node scripts/run-msvc.mjs cargo test -p bibcode-server --test windows_terminal_shims` exits 0, including the new test

Steps

1. [ ] Write the failing test `shim_timeout_reports_the_collected_output`: spawn a `.cmd` shim that echoes `BEFORE` and then waits 15 seconds, and call `wait_for_marker` on its output and exit subscriptions with a 2-second deadline; assert the error contains `timed out`, `BEFORE` and `exit=None`, then kill the terminal.
2. [ ] Run the test target in the Windows VM. Expected: FAIL to compile, `wait_for_marker` does not exist.
3. [ ] Implement: move only the wait loop of `assert_shim_output` into `wait_for_marker`, keeping the text outside the timed future so it survives the timeout, and return the described error on `Elapsed`; `assert_shim_output` calls it with 10 seconds, panics with the error, and keeps its marker assertion, its 10-second exit wait and its exit code 0 assertion unchanged.
4. [ ] Run the test target in the Windows VM. Expected: PASS, 24 tests; then `node scripts/run-msvc.mjs cargo check -p bibcode-server --all-targets` with warnings denied as CI sets them, and `node scripts/run-msvc.mjs cargo clippy -p bibcode-server --test windows_terminal_shims -- -D warnings`. Expected: no warnings. If the VM cannot run them, the pull request's `server_tests_windows` job is the compile and run proof, and Clippy on this Windows-only file is reported as not run.
5. [ ] Prove the test can fail: drop the collected text from the error, run. Expected: FAIL. Restore, run. Expected: PASS.
6. [ ] Run `cargo fmt --all --check` on the host. Expected: no changes.

### Task 4.2: Measure the #367 rate under load in the Windows arm64 VM

- Satisfies: R7
- Depends on: 4.1
- Files: none
- Interfaces: produces a result line `k of 30 failed`, returned to the executor for `progress.md` and published by Task 5.3
- Skills: mstack-diagnose (flaky branch: fixed count, no early stop)
- Read first: `research/measured_ci_and_local.md` section 5
- Tier: standard
- TDD: exempt (a measurement run, no behavior changes)
- Done when: 30 runs are counted and the result, with any failure's printed output, is recorded in `progress.md`; or the VM cannot run them, which is recorded as `not run: <reason>`, closes this task, and leaves R7 unaccepted and #367 open

Steps

1. [ ] Start four busy processes in the VM (PowerShell jobs running `while ($true) {}`, their ids written to a file), then run `cargo test -p bibcode-server --test windows_terminal_shims -- review_prompt_shim_` 30 times without stopping at a failure, counting non-zero exits. Expected: a count `k of 30`.
2. [ ] Stop the busy processes by the recorded ids, in a `finally` block so a failed run still stops them. Expected: none left running.
3. [ ] Report `k of 30`, the command, the VM's core count and any failure's output to the executor. Expected: one log line in `progress.md`.
