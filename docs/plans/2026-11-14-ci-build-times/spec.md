# CI build times, symbol dump error and Windows arm64 flake (#363, #364, #367, #368)

Status: Approved 2026-11-14 (the user's standing pre-approval of 2026-10-30: reviewed twice by Codex and by the advisor, findings handled; decisions D2 to D6 are the agent's calls, listed for confirmation in the pull request)
Size: full Mode: gated Type: performance and chore (#363, #368), bug (#364), flaky test (#367)
Source: GitHub issues #363, #364, #367 and #368 of this repository as they stood on 2026-11-14, the conversation of 2026-11-14 ("create a new PR and fix all open issues, also do a deep research about these recurrent build time problems, check the real reason of them"), the job logs and jobs API of ten `main` CI runs (2026-11-04 to 2026-11-14), and local builds on 2026-11-14. Evidence: [research/measured_ci_and_local.md](research/measured_ci_and_local.md). Research: [research/report.md](research/report.md).

## Problem

CI on `main` takes two to four hours, jobs hit their time limits, and the same explanation ("no Rust cache") has been recorded each time. The measurements say otherwise:

- **The server crate, not the cache, is the cost.** Swatinem/rust-cache never stores workspace crates. In the bundle step, Cargo starts the last dependency about 6 to 7 minutes in when nothing is cached and 2.5 minutes in on a full match; the remaining 23 minutes on Linux x64, 42 on Windows x64 and 81 to 107 on macOS arm64 are spent with only `bibcode-server`, `bibcode-desktop` and the thin-LTO link left to start. These are start times of `Compiling` lines, so the split is an estimate. Locally the three workspace units take 1125 of 1299 seconds, and with one codegen unit they compile mostly on one core.
- **A Windows native row compiles `bibcode-server` five times** (desktop host tests, `cargo check --all-targets`, two server test builds, the release bundle): 76 of 103 minutes, against about 2 minutes of running tests (#368).
- **The cache store cannot hold what CI saves.** It sits at 9.98 GiB of a 10 GB limit; the entries CI wants total about 17 GB. In the latest `main` run 11 of 13 Rust-cache restores found nothing. A Windows arm64 entry restored at 01:09 was gone at 02:08. Pull requests also save 0.48 GiB pnpm store entries that only their own re-runs can read. This costs each job 5 to 12 minutes; it is real, and it is not the main cause.
- **#363.** The macOS bundle build went from 37-40 minutes to 75-111 when the symbol profile was turned on; Linux did not change. Locally (12 cores, 96 GB) the symbol profile costs nothing (1260 s against 1299 s) and `dsymutil` is not visible in a 15-second sampler. The `rustc` process for `bibcode-server` peaks at 8.7 GB with the shipped profile and at 9.6 GB with the symbol profile (one sampled run each); the macOS arm64 runner has 3 cores and 7 GB. Memory pressure on that runner is the leading explanation and is not proven; debug-info cost in the compiler or the link on that hardware is not ruled out.
- **#364.** `dump_syms` logs `[ERROR] CFI: CfiError { kind: BadDebugInfo, ... }` in 7 of 24 macOS job logs and exits 0. Reproduced locally with the build that used 16 codegen units (the one-unit build dumped six times without the error): dumping the dSYM's DWARF file alone logs the error and yields no `STACK` records, dumping the binary alone logs nothing, and the merged file is identical in its `STACK` records to the binary-only dump (635,173 records, 0 lines differ). The dSYM's `__unwind_info` section header has file offset 0, so the parser reads unrelated bytes. In that case the stored file is complete. The same log line would also appear if the binary's own unwind data failed to parse, and then the writer stops at the failing entry and the file is truncated; nothing tells the two cases apart today.
- **#367.** Four `review_prompt_shim_*` tests timed out after 10 s on Windows arm64, once in ten runs of the step. They were the first four tests libtest started; the six started after them passed in 5 s. The test discards the terminal output before it panics, so the log cannot say whether the marker was late or never printed.

## Goals

1. A pull request's Windows native rows finish sooner, and no step compiles the server for tests inside a row that also builds the bundle.
2. The bundle build of the two workspace crates uses more than one core in CI, without changing the binary Release ships or invalidating the dependency cache Release restores.
3. One labelled CI run records where the macOS bundle time and memory go, so the #363 explanation is measured.
4. A symbol dump that logs a `dump_syms` error either proves the stored file complete or fails.
5. The next #367 failure prints the terminal output and exit state, and a bounded load test on Windows arm64 records whether the cold-start explanation holds.
6. Pull requests stop adding entries to the cache store.

## Non-goals

- Splitting `bibcode-server` into several crates. It is the structural fix for one-core compiles and is a design of its own.
- Changing the shipped release profile in `Cargo.toml` (thin LTO, one codegen unit). Release keeps building exactly what it builds today (D2).
- Raising the repository's Actions cache limit. It is an account setting with a cost, so it is the user's decision; the pull request states the numbers (D5).
- sccache, third-party runners or cache backends: no measurement supports them for a build dominated by two first-party crates.
- A larger timeout or serial execution for the #367 tests without evidence of the cause.

## Decisions

- D1. One pull request covers the four issues. Decided by: user, 2026-11-14.
- D2. CI bundle builds compile `bibcode-server` and `bibcode-desktop` with 16 codegen units through a Cargo `--config` override for those two packages only. Release does not pass it. Alternatives: change the shipped profile (changes the product binary and needs a runtime measurement), a `CARGO_PROFILE_RELEASE_CODEGEN_UNITS` environment override (rebuilds every dependency, so the shared cache stops working), leave it (keeps 23 to 107 serial minutes per row). Cost: CI no longer compiles the two workspace crates exactly as Release does; it still proves the thin-LTO link, the symbol dump, stripping and bundling, and Release itself proves the shipped profile. Decided by: agent's call, to confirm with the user.
- D3. The override applies to every CI row including macOS. The macOS arm64 row's memory heartbeat (R4) decides whether it stays there: if the row's bundle build is slower than 81 minutes with it, the override is removed from that row in the same pull request. Decided by: agent's call.
- D4. The Windows server tests move to a job of their own, as the macOS ones did, and drop `-j 2` there because nothing else runs beside the compiler in that job. If the first pull request run shows that job failing for lack of memory, the flag returns and this spec records it. The `cargo check --all-targets` step moves with them. Decided by: agent's call, from the measured step times.
- D5. The cache limit stays at 10 GB in this pull request. Decided by: agent's call (it is the user's setting).
- D6. #367 is not closed by this pull request unless the load test reproduces the failure and a change flips it. The pull request refers to it. Decided by: agent's call.
- D7. A design or plan counts as approved once Codex and the advisor have reviewed it and their findings are handled. Decided by: user's standing rule of 2026-10-30.

## Requirements

### R1. Symbol dump verifies its output when dump_syms reports an error (Must, #364)

`scripts/dump-symbols.ts` reads what `dump_syms` writes to standard error and still shows it. When that output contains a line with `[ERROR]`, the script finds out which input the error belongs to. With a `--dsym` input it runs `dump_syms` once more on the binary alone. If that run logs no error, the binary's unwind records were written completely, so the script requires the stored file to hold the same number of `STACK` records as the binary-only dump and prints one line saying so. If the binary-only run logs an error too, or the counts differ, or there was no `--dsym` input to set aside, it fails.

- GIVEN a `--dsym` input, a first run that exits 0 and logs `[ERROR] CFI: CfiError { kind: BadDebugInfo, source: Some(UnknownVersion(0)) }`, and a binary-only run that logs nothing and writes the same 3 `STACK` records, WHEN the script runs, THEN it exits 0 and prints `dump_syms reported an error for the dSYM; the binary's 3 STACK records are all stored`.
- GIVEN the same first run and a binary-only run that logs the error again, WHEN the script runs, THEN it fails with `dump_syms reported an error while reading the unwind tables of the binary`.
- GIVEN the same first run and a binary-only run that writes 5 `STACK` records against 3 stored, WHEN the script runs, THEN it fails with `the stored symbols hold 3 STACK records, the binary 5`.
- GIVEN no `--dsym` input and a run that logs an `[ERROR]` line, WHEN the script runs, THEN it fails with `dump_syms reported an error`.
- GIVEN `dump_syms` logs nothing, WHEN the script runs, THEN it runs `dump_syms` once and behaves as it does today.

### R2. Windows server tests run in their own job (Must, #368)

A job `server_tests_windows` runs on `windows-2025` and `windows-11-vs2026-arm` on every pull request. It holds, in this order, the steps `Check Windows server test targets compile`, `Run Git system configuration tests (Windows)`, `Run background Git index lock tests (Windows)`, `Run review prompt argument tests (Windows)` and `Run host metrics tests (Windows)`, with the same commands minus `-j 2`; the review prompt step's filter becomes `review_prompt_shim_ shim_timeout_` so it also runs R6's test. The native desktop rows no longer contain them. The job restores the native desktop Rust cache and never saves one. Its time limit is 90 minutes.

- GIVEN the workflow, WHEN the contract test reads `native_desktop`, THEN no step name ends in `(Windows)` except `Test Windows desktop E2E support contracts`.
- GIVEN the workflow, WHEN the contract test reads `server_tests_windows`, THEN it finds the five steps in order, `save-if: "false"`, `shared-key: native-desktop` and `timeout-minutes: 90`, and no command contains `-j 2`.
- GIVEN a pull request run, WHEN it finishes, THEN each Windows native row took less than 89 minutes (x64) and 103 minutes (arm64), the times of run 43562279474, and the pull request states both numbers.

### R3. CI bundle builds use 16 codegen units for the workspace crates (Must, #363)

`scripts/build-desktop-artifact.ts` accepts `--workspace-codegen-units <n>` and passes `--config profile.release.package.bibcode-server.codegen-units=<n>` and the same for `bibcode-desktop` to Cargo in the build step. `ci.yml` passes `--workspace-codegen-units 16`. `release.yml` does not.

- GIVEN `--workspace-codegen-units 16`, WHEN the plan is built, THEN the build command ends with `-- --config profile.release.package.bibcode-server.codegen-units=16 --config profile.release.package.bibcode-desktop.codegen-units=16` and the bundle command is unchanged.
- GIVEN no flag, WHEN the plan is built, THEN the build command is the one built today.
- GIVEN `--workspace-codegen-units 0` or a non-number, WHEN arguments are parsed, THEN the script fails with `--workspace-codegen-units must be a whole number from 1 to 256.`
- GIVEN a target built with the shipped profile, WHEN the build is repeated with the override, THEN Cargo compiles only `bibcode-server` and `bibcode-desktop`.
- GIVEN the contract test, WHEN it reads `release.yml`, THEN no line contains `--workspace-codegen-units`.

### R4. The bundle step records time and memory (Must, #363)

The CI bundle step writes a heartbeat every 60 seconds while it runs: elapsed seconds, the resident memory of each `rustc`, linker and `dsymutil` process, and the system's free memory and swap use. On Windows it records elapsed time only. When the step ends it prints one `::notice::` with the build's seconds and the peak single-process memory. The heartbeat never fails the step.

- GIVEN a run labelled `ci:full`, WHEN the macOS arm64 row finishes, THEN its log holds heartbeat lines for the whole bundle build and the notice, and the pull request records the peak memory, the swap use and the build time next to the 81 to 107 minute baseline.

### R5. Pull requests stop saving pnpm store entries (Must)

Every `voidzero-dev/setup-vp` step with `cache: true` in the workflows sets `cache-save: ${{ github.ref == 'refs/heads/main' }}`.

- GIVEN the workflows, WHEN the contract test reads every `setup-vp` step with `cache: true`, THEN each has that `cache-save` value.

### R6. A shim test timeout shows what the terminal printed (Must, #367)

When `assert_shim_output` in `apps/server/tests/windows_terminal_shims.rs` times out waiting for the marker, the panic message holds the output collected so far and the exit state. Its checks after the marker (the terminal exits within 10 seconds with code 0) stay as they are.

- GIVEN a shim that sleeps past the deadline after printing `BEFORE`, WHEN the helper times out, THEN the panic message contains `timed out`, `BEFORE` and `exit=None`.

### R7. A bounded load test records whether #367 reproduces (Should, #367)

The step's command runs 30 times in the Windows arm64 VM while four processes keep its cores busy, with the count fixed before the first run. The result (failures of 30, and the output R6 prints for any failure) goes into the issue.

- GIVEN 30 runs, WHEN at least one fails, THEN its printed output decides the next change and a comment on the issue records it. WHEN none fails, THEN a comment on the issue records `0 of 30` and the issue stays open.

### R8. The living documents state the measured causes (Must)

`docs/operations/ci.md` describes the new job, the override, the heartbeat, the `cache-save` rule and the measured cache budget (about 17 GB wanted against 10 GB), and no longer explains the Windows and macOS row times by a missing cache. `docs/operations/release.md` says that the `dump_syms` CFI error from a dSYM is expected and verified. The Windows testing runbook lists the server tests under their new job.

## Verification

- `vp test run scripts` passes, including the new cases in `scripts/dump-symbols.test.ts`, `scripts/build-desktop-artifact.test.ts` and `scripts/ci-platform-contract.test.ts`.
- `vp check`, `vp run typecheck`, `vp run check:markdown-links` and `cargo fmt --all --check` pass.
- The Windows VM compiles and runs `cargo test -p bibcode-server --test windows_terminal_shims`.
- One pull request CI run with `ci:full` is green; its step times and the macOS heartbeat are recorded in the pull request against the baselines in [research/measured_ci_and_local.md](research/measured_ci_and_local.md).
