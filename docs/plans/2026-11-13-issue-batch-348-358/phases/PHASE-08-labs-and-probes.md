# Phase 8: Lab runs and bounded probes

- Goal: Every requirement whose proof needs a packaged app, another operating system or a real pair has a recorded result, and each "decide by probe" item is decided.
- Round: 2
- Depends on: 1, 2, 3, 4, 5, 6, 7
- Owns: nothing in the repository. Lab scripts, logs, screenshots and probe scripts stay in the session scratch folder.
- Must not touch: product source under `apps/web/src`, `apps/server/src`, `packages/**`. A defect found here goes back to the phase that owns the file, as a new task there.
- Skills: bibcode-profiler (Profiler is on in every run and its data is read); mstack-diagnose (any failing run is diagnosed before a fix)
- Read first: `docs/testing/README.md`, `docs/testing/linux-desktop.md`, `docs/testing/windows-desktop.md`, `docs/testing/cross-platform-validation.md` (the real lab procedures); `docs/skills/bibcode-profiler/SKILL.md` (how to turn the Profiler on and read its findings); `AGENTS.md` (no manual steps for the user; sensitive data)
- Checkpoint: `progress.md` holds one log line per task below with the command, the counts and the profiler findings, each finding classed as caused by this change, pre-existing or a test artifact.

Rules for every task in this phase: the Profiler is on; a run's numbers go into the plan log, never into a living runbook; nothing is downloaded except this repository's own release assets through `gh release download`; no run touches the user's live BiBCode instance or their own Git host logins.

## Tasks

### Task 8.1: Linux lab run of the packaged list, with the two discriminating runs

- Satisfies: R12 (the 1000x720 run), R20, spec Verification (Linux lab)
- Depends on: 5.2, 7.2
- Files: none in the repository
- Interfaces: consumes the Linux lab image `bibcode-linux-lab:22.04` (rebuild it from `docs/testing/linux-desktop.md` and the Linux leg of `.github/workflows/desktop-ui-smoke.yml` when it is missing); produces log lines in `progress.md`
- Skills: bibcode-profiler (findings of the run are classified)
- Read first: `docs/testing/linux-desktop.md` (build and run procedure); `.github/workflows/desktop-ui-smoke.yml` (the exact packaged commands)
- Tier: standard
- TDD: exempt (a pure command run with recorded results)
- Done when: the packaged default list passes in the lab, `chat-reasoning-rows` passes at a 1000x720 viewport, and the R20 numbers are in the log

Steps

1. [ ] Check free disk with `df -h /`. Expected: at least 60 GB free; otherwise stop and report.
2. [ ] Build the branch head in the lab with `CARGO_BUILD_JOBS=4`. Expected: the packaged app builds.
3. [ ] Run the packaged default list, Profiler on, with `GST_PLUGIN_PATH` set as the runbook says. Expected: every spec passes; a failure is diagnosed, not rerun blindly.
4. [ ] Run `chat-reasoning-rows` with the window at 1000x720. Expected: PASS (before Phase 5's fix this run was the discriminator; the baseline result is in the log from the start of execution, see plan decision P3).
5. [ ] R20: in one packaged run, switch between Settings and a thread ten times, then read the profiler data. Expected: record the longest main-thread stall and the web process's memory at start and end. A `client.stall` or `memory.leak-suspect` or `memory.leak-likely` finding that carries a trace opens a diagnosis task in the phase that owns the traced code; with no such finding, log "no finding with a trace; nothing changed".
6. [ ] Log every profiler finding of the run with its class (caused by this change, pre-existing, test artifact).

### Task 8.2: Mixed-version probe against the previous release's server

- Satisfies: R19
- Depends on: 1.6
- Files: none in the repository (the probe script lives in the session scratch folder)
- Interfaces: consumes `scripts/resolve-previous-release-tag.ts` (the previous release tag), that release's Linux server asset, and the current `@bibcode/client-runtime` terminal RPC functions; produces a log line with each call's outcome
- Skills: mstack-diagnose (a failing legacy path is diagnosed before any fix)
- Read first: `scripts/resolve-previous-release-tag.ts` (how the tag is resolved); `packages/client-runtime/src/state/terminal.ts` (the attach, resize and keybinding calls); `docs/testing/cross-platform-validation.md` sections on older servers (what "legacy path" means for each call)
- Tier: most capable
- TDD: exempt (a probe whose result is recorded; a failure becomes a red-green task in the owning phase)
- Done when: `rg -n "8.2 Closed" docs/plans/2026-11-13-issue-batch-348-358/progress.md` finds the log line, and it states, for attach, resize and keybindings, "legacy path, no error" or names the failing call and the new task that fixes it

Steps

1. [ ] Resolve the previous release tag with `node scripts/resolve-previous-release-tag.ts`. Expected: a tag older than this branch's version.
2. [ ] Inside the Linux lab container, fetch that release's server asset with `gh release download <tag>` from this repository only, into a new empty directory, and start it headless on a loopback port with an isolated data home. Expected: the server answers its health route.
3. [ ] From a node script that imports the current client runtime, connect, read the server's capabilities, then call terminal attach, resize and the keybindings read. Expected: capabilities hold no `terminalSizeHandOver`; each call returns through its legacy path with no error.
4. [ ] Stop the server by its own PID and remove only the directory this task created. Expected: no leftover process.
5. [ ] Log the outcome. A failing call opens a task in the phase that owns the failing code.

### Task 8.3: Windows VM runs

- Satisfies: R12 (Windows proof), R13 (12 whole-suite runs), spec Verification (Windows)
- Depends on: 5.2, 3.1
- Files: none in the repository
- Interfaces: consumes the Windows 11 arm64 VM through the wrapper procedure in `docs/testing/windows-desktop.md`; produces log lines in `progress.md`
- Skills: bibcode-profiler (the packaged runs have the Profiler on)
- Read first: `docs/testing/windows-desktop.md` (build, test and packaged procedures for Windows)
- Tier: standard
- TDD: exempt (a pure command run with recorded results)
- Done when: the log holds `chat-reasoning-rows` PASS at the viewport where it failed (1000x720 CSS px), 12 of 12 whole-suite passes of `cargo test -p bibcode-server` for the removal test, and exit 0 for fmt, Clippy, `vp check` and typecheck

Steps

1. [ ] Copy the branch head into the VM as the runbook says and build. Expected: the build succeeds.
2. [ ] Run `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `vp check`, `vp run typecheck`. Expected: exit 0 each.
3. [ ] Run `cargo test -p bibcode-server` 12 times, one after the other, with no other load-heavy job on the Mac. Expected: `removal_refuses_when_an_admission_does_not_drain_before_the_deadline` passes in 12 of 12; any other failure is logged with its name and compared with `main`.
4. [ ] Run the packaged `chat-reasoning-rows` spec. Expected: PASS; the expanded header moves at most 2 px.
5. [ ] Log the results and the profiler findings with their class.

### Task 8.4: Load runs on the Mac

- Satisfies: R13 (50 runs alone under load)
- Depends on: 3.1
- Files: none in the repository
- Interfaces: consumes the test name `removal_refuses_when_an_admission_does_not_drain_before_the_deadline`; produces a log line with the pass count
- Skills: none
- Read first: `docs/testing/flaky-tests.md` (how repeated runs under load are done and reported)
- Tier: cheap
- TDD: exempt (a pure command run with recorded results)
- Done when: the loop of `cargo test -p bibcode-server --lib removal_refuses_when_an_admission_does_not_drain_before_the_deadline` reports 50 passes and 0 failures, and the log holds that count

Steps

1. [ ] Start CPU load with one busy process per core, keep their PIDs, and never stop processes by name. Expected: load is visible in `uptime`.
2. [ ] Run `cargo test -p bibcode-server --lib removal_refuses_when_an_admission_does_not_drain_before_the_deadline` 50 times in a loop that counts exit codes. Expected: 50 passes, 0 failures.
3. [ ] Stop exactly the PIDs from step 1. Expected: none left.
4. [ ] Log the count. A failure reopens Task 3.1.

