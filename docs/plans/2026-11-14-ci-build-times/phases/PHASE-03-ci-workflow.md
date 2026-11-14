# Phase 3: CI workflow

- Goal: CI runs the Windows server tests in their own job, builds bundles with the override and a heartbeat, and stops pull requests saving pnpm entries, each pinned by a contract test.
- Round: 2
- Depends on: 2
- Owns: `.github/workflows/*.yml`, `scripts/ci-platform-contract.test.ts`
- Must not touch: `scripts/dump-symbols.ts`, `scripts/build-desktop-artifact.ts`, `docs/`
- Skills: tdd (contract test first); issue-delivery (checkpoint rules before any CI dispatch)
- Read first: `docs/operations/ci.md` (what each job promises today); `research/measured_ci_and_local.md` sections 1 and 2 (the baselines the new run is compared with)
- Checkpoint: `vp test run scripts/ci-platform-contract.test.ts` passes, and the workflow files parse.

## Tasks

### Task 3.1: Move the Windows server tests into server_tests_windows

- Satisfies: R2 (native rows without the steps, new job with them)
- Depends on: none
- Files: modify `.github/workflows/ci.yml`; test `scripts/ci-platform-contract.test.ts`
- Interfaces: produces the job id `server_tests_windows` with rows labelled `Windows x64` (`windows-2025`) and `Windows arm64` (`windows-11-vs2026-arm`), job name `Server tests - ${{ matrix.label }}`
- Skills: tdd (contract case first)
- Read first: the `server_tests_macos` job in `.github/workflows/ci.yml` (the shape to mirror)
- Tier: standard
- TDD: red-green
- Done when: `vp test run scripts/ci-platform-contract.test.ts` exits 0 with the new case passing

Steps

1. [ ] Write a failing contract case: `server_tests_windows` exists, has no `if`, `timeout-minutes` 90, a rust-cache step with `shared-key: native-desktop` and `save-if: "false"`, the five step names in the spec's order, no `-j 2` in any command, the review prompt step's filter `-- review_prompt_shim_ shim_timeout_`, the `counted` helper in the host metrics step; and `native_desktop` has no step whose name ends in `(Windows)` and no `cargo check -p bibcode-server` or `cargo test -p bibcode-server` command.
2. [ ] Run `vp test run scripts/ci-platform-contract.test.ts`. Expected: FAIL, the job is missing.
3. [ ] Edit `ci.yml`: add the job after `server_tests_macos` (Checkout, Setup Vite+ with `node-version-file: package.json`, `run-install: false` and no cache, Setup Rust, the restore-only cache step, then the five steps moved from `native_desktop` without their `if` and without `-j 2`); delete them from the shared native steps; update any existing contract cases that looked for them in the native rows.
4. [ ] Run `vp test run scripts/ci-platform-contract.test.ts`. Expected: PASS.
5. [ ] Prove the test can fail: put `-j 2` back on one command, run. Expected: FAIL. Restore, run. Expected: PASS.
6. [ ] Run `vp check .github/workflows/ci.yml scripts/ci-platform-contract.test.ts`. Expected: no errors.

### Task 3.2: Pass the override and record a heartbeat in the bundle step

- Satisfies: R3 (CI passes 16, Release does not), R4 (heartbeat and notice)
- Depends on: 2.1, 3.1
- Files: modify `.github/workflows/ci.yml`; test `scripts/ci-platform-contract.test.ts`
- Interfaces: consumes `--workspace-codegen-units <n>` from Task 2.1; produces heartbeat lines `heartbeat <seconds>s ...` and a notice titled `Bundle build`
- Skills: tdd (contract case first)
- Read first: the `Crash the smoke binary` step in `ci.yml` (the existing `trap` and `::notice::` pattern)
- Tier: standard
- TDD: red-green
- Done when: `vp test run scripts/ci-platform-contract.test.ts` exits 0 with the new case passing

Steps

1. [ ] Write a failing contract case: the bundle step of `native_desktop` uses `shell: bash`, contains `--workspace-codegen-units 16`, starts a background loop that sleeps 60 seconds, installs a `trap` that stops the loop on exit and prints `::notice title=Bundle build::`, reads resident memory with `ps`, and does not use `set +e` or `|| true` on the build command itself; and `release.yml` contains no `--workspace-codegen-units`.
2. [ ] Run `vp test run scripts/ci-platform-contract.test.ts`. Expected: FAIL.
3. [ ] Edit the step: a bash script that starts the loop (elapsed seconds; on macOS and Linux `ps -Ao rss=,comm=` filtered to `rustc`, `ld`, `lld`, `dsymutil`, plus `vm_stat` and `sysctl vm.swapusage` on macOS and `/proc/meminfo` on Linux; elapsed only on Windows), tracks the peak single-process resident memory in a file, traps EXIT to kill the loop and print the notice with seconds and peak, and then runs the existing command with the new flag. Every heartbeat command ends in `|| true`.
4. [ ] Run `vp test run scripts/ci-platform-contract.test.ts`. Expected: PASS.
5. [ ] Run the step's script locally three times with the build command replaced: by `sleep 130` (expected: two heartbeat lines with memory values, the notice, exit 0, no loop process left); by `sh -c 'sleep 2; exit 7'` (expected: the notice, exit 7, no loop process left); and with `PATH` reduced so `ps` is missing (expected: heartbeat lines without memory values, exit 0). Expected: all three probes behave as listed.
6. [ ] Prove the test can fail: remove the flag from the step, run the contract test. Expected: FAIL. Restore, run. Expected: PASS.

### Task 3.3: Save pnpm store entries only on main

- Satisfies: R5
- Depends on: 3.2
- Files: modify `.github/workflows/*.yml`; test `scripts/ci-platform-contract.test.ts`
- Interfaces: none
- Skills: tdd (contract case first)
- Read first: `research/actions_cache_limits.md` (pull request entries count against the same limit)
- Tier: cheap
- TDD: red-green
- Done when: `vp test run scripts/ci-platform-contract.test.ts` exits 0 with the new case passing

Steps

1. [ ] Write a failing contract case that reads every workflow file and requires, for each `voidzero-dev/setup-vp` step with `cache: true`, `cache-save` equal to `${{ github.ref == 'refs/heads/main' }}`.
2. [ ] Run `vp test run scripts/ci-platform-contract.test.ts`. Expected: FAIL, listing the steps.
3. [ ] Add the input to each such step.
4. [ ] Run `vp test run scripts/ci-platform-contract.test.ts`. Expected: PASS.
5. [ ] Prove the test can fail: remove the input from one step, run. Expected: FAIL. Restore, run. Expected: PASS.
6. [ ] Run `vp test run scripts`. Expected: PASS, no other workflow contract broken.
