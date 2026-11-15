# Phase 8: Lab runs and bounded probes

- Goal: Every requirement whose proof needs a packaged app or another operating system has a recorded result, and each "decide by probe" item is decided.
- Round: 2
- Depends on: 1, 2, 3, 4, 5, 6, 7
- Owns: nothing in the repository. Lab scripts, logs, screenshots and probe scripts stay in the session scratch folder or inside the lab container.
- Must not touch: product source under `apps/web/src`, `apps/server/src`, `packages/**`. A defect found here goes back to the phase that owns the file, as a new task there.
- Skills: bibcode-profiler (Profiler is on in every run and its data is read); mstack-diagnose (any failing run is diagnosed before a fix)
- Read first: `docs/testing/README.md`, `docs/testing/linux-desktop.md`, `docs/testing/windows-desktop.md`, `docs/testing/cross-platform-validation.md` (the real lab procedures); `docs/skills/bibcode-profiler/SKILL.md` (how to turn the Profiler on and read its findings); `AGENTS.md` (no manual steps for the user; sensitive data)
- Checkpoint: `rg -n "^- .* 8\.[1-4] Closed" docs/plans/2026-11-13-issue-batch-348-358/progress.md` finds four lines, each with the command, the counts and the profiler findings classed as caused by this change, pre-existing or a test artifact.

Rules for every task in this phase: the Profiler is on; a run's numbers go into the plan log, never into a living runbook; nothing is downloaded except this repository's own release assets through `gh release download`; no run touches the user's live BiBCode instance or their own Git host logins; a long task logs after each numbered step so it can resume from the log.

## Tasks

### Task 8.1: Linux lab run of the packaged list, with the webview-kill and route-change probes

- Satisfies: R12 (guard against a Linux regression), R15 (real proof), R20, R35 (the marker survives a relaunched web process), spec Verification (Linux lab)
- Depends on: 4.2, 5.2, 7.2
- Files: none in the repository
- Interfaces: consumes the existing Linux lab container `bibcode-linux-lab` (image `bibcode-linux-lab:22.04`, cache volume `bibcode-linux-lab-cache`), which holds a source tree, a build cache and the lab's run script; consumes the per-test probe of Task 7.2 and the reload marker of Task 4.2 (its key and the DOM state to assert are in Task 4.2's Interfaces); produces log lines in `progress.md`
- Skills: bibcode-profiler (findings of the run are classified)
- Read first: `docs/testing/linux-desktop.md` (build and run procedure); `.github/workflows/desktop-ui-smoke.yml` Linux leg (the exact packaged commands the lab mirrors); `apps/desktop/e2e/wdio.conf.ts` (how `BIBCODE_E2E_SPEC` selects specs)
- Tier: most capable
- TDD: exempt (a pure command run with recorded results)
- Done when: `docker exec bibcode-linux-lab cat <run folder>/exit-code` prints `0` for the default-list run, and the log holds the default-list counts, the webview-kill result, the reload-marker result and the R20 numbers

Steps

1. [ ] Run `df -h /` and `docker ps --filter name=bibcode-linux-lab`. Expected: at least 60 GB free and the container listed. If the image or container is absent, stop and report: its Dockerfile was not kept, and rebuilding it is a decision for the user.
2. [ ] Copy the branch head into the container as a `git archive` and build the packaged app with `CARGO_BUILD_JOBS=4`. Expected: an AppImage for the branch head exists.
3. [ ] Run the packaged default list under `xvfb-run` with the Profiler on and `GST_PLUGIN_PATH` set as the runbook says. Expected: every spec passes, including `chat-reasoning-rows` (the harness sets a 1000x720 viewport itself); a failure is diagnosed, not rerun blindly.
4. [ ] R15: start a run of two shared specs and end the web process of the app by its PID (found as the child of the app's own PID, never by name) while a test is running, so that test fails and its `afterTest` evidence collection meets a dead webview. Expected: `afterTest` does not throw, the next test's `beforeTest` relaunches the app once inside its time allowance, and that test and the ones after it run on the new app; before Task 7.2's change the same scenario skips or fails every later shared spec.
5. [ ] R35: with unsaved Files edits and an allowed remote install simulated by the harness's update mock, reload the page, then end the web process by its PID so the app starts a new one. Expected: after each, the installing dialog is shown and saving is held, as Task 4.2's Interfaces state; if the marker does not survive the relaunched web process, reopen Task 4.2 with that result.
6. [ ] R20: in one packaged run, switch between Settings and a thread ten times, then read the profiler data. Expected: record the longest main-thread stall and the web process's memory at start and end. A `client.stall`, `memory.leak-suspect` or `memory.leak-likely` finding that carries a trace opens a diagnosis task in the phase that owns the traced code; with no such finding, log "no finding with a trace; nothing changed".
7. [ ] Log every profiler finding of the runs with its class (caused by this change, pre-existing, test artifact).

### Task 8.2: Mixed-version probe against the latest released server

- Satisfies: R19
- Depends on: 1.6
- Files: none in the repository (the probe script lives in the session scratch folder)
- Interfaces: consumes the latest published release of this repository (its tag from `gh release list --limit 1`, which is older than this branch's changes), that release's Linux aarch64 server package and `bibcode-server-SHA256SUMS`, and the current `@bibcode/client-runtime` terminal RPC functions; produces a log line with each call's outcome
- Skills: mstack-diagnose (a failing legacy path is diagnosed before any fix)
- Read first: `packages/client-runtime/src/state/terminal.ts` (the attach, resize and keybinding calls); `docs/testing/cross-platform-validation.md` sections on older servers (what "legacy path" means for each call); `docs/user/server-installation.md` and `docs/cloud/environment-auth.md` (how the headless server is started and how a client pairs with a fresh server)
- Tier: most capable
- TDD: exempt (a probe whose result is recorded; a failure becomes a red-green task in the owning phase)
- Done when: `rg -n "8\.2 Closed" docs/plans/2026-11-13-issue-batch-348-358/progress.md` finds the log line, and it states, for attach, resize and keybindings, "legacy path, no error" or names the failing call and the new task that fixes it

Steps

1. [ ] Run `gh release list --limit 1 --json tagName --jq '.[0].tagName'`. Expected: a tag such as `v0.15.3` whose commit is an ancestor of `main`.
2. [ ] Inside the Linux lab container, in a new empty directory, run `gh release download <tag> --pattern 'bibcode-server-*aarch64*' --pattern 'bibcode-server-SHA256SUMS'` and check the package against the checksum file. Expected: the checksum matches; a mismatch stops the task.
3. [ ] Unpack the package without installing it system-wide and start the server headless on a loopback port with an isolated data home, as `docs/user/server-installation.md` describes. Expected: the server answers its health route.
4. [ ] From a node script that imports the current client runtime, pair with the server as `docs/cloud/environment-auth.md` describes for a fresh server, read its capabilities, then call terminal open and attach, a resize, and the keybindings read. Expected: capabilities hold no `terminalSizeHandOver`; each call returns through its legacy path with no error.
5. [ ] Stop the server by its own PID and remove only the directory this task created. Expected: no leftover process.
6. [ ] Log the outcome. A failing call opens a task in the phase that owns the failing code.

### Task 8.3: Windows VM runs

- Satisfies: R12 (the live trace and the Windows proof), R13 (12 whole-suite runs), spec Verification (Windows)
- Depends on: 5.1, 3.1
- Files: none in the repository
- Interfaces: consumes the Windows 11 arm64 VM through the wrapper procedure in `docs/testing/windows-desktop.md`; consumes the temporary `[DEBUG-r12]` instrumentation of Task 5.1 for the trace run and the fix of Task 5.2 for the proof run; produces the trace lines for Task 5.1 and log lines in `progress.md`
- Skills: bibcode-profiler (the packaged runs have the Profiler on)
- Read first: `docs/testing/windows-desktop.md` (build, test and packaged procedures for Windows)
- Tier: most capable
- TDD: exempt (a pure command run with recorded results)
- Done when: `rg -n "8\.3 Closed" docs/plans/2026-11-13-issue-batch-348-358/progress.md` finds the log line, and it holds `chat-reasoning-rows` PASS on the fixed build, 12 of 12 whole-suite passes of `cargo test -p bibcode-server` for the removal test, and exit 0 for fmt, Clippy, `vp check` and typecheck

Steps

1. [ ] Trace run, when Task 5.1 asks for it: copy the instrumented build into the VM, run the packaged `chat-reasoning-rows` spec, and hand the `[DEBUG-r12]` lines back to Task 5.1. Expected: the spec fails as in the issue and the lines name the scrolling path. Log the lines.
2. [ ] After Task 5.2: copy the branch head into the VM as the runbook says and build. Expected: the build succeeds. Log it.
3. [ ] Run `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `vp check`, `vp run typecheck`. Expected: exit 0 each. Log it.
4. [ ] Run the packaged `chat-reasoning-rows` spec. Expected: PASS; the expanded header moves at most 2 px. Log it.
5. [ ] Run `cargo test -p bibcode-server` 12 times, one after the other, with no other load-heavy job on the Mac, logging after each run. Expected: `removal_refuses_when_an_admission_does_not_drain_before_the_deadline` passes in 12 of 12; any other failure is logged with its name and compared with `main`.
6. [ ] Log the profiler findings of the packaged runs with their class.

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
