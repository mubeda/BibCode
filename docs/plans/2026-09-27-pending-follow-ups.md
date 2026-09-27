# Pending follow-ups after v0.7.0 (2026-09-27)

This is the backlog left when the 2026-09-26/27 follow-ups program was cut down to ship v0.7.0. It is historical planning evidence: check paths, line numbers and designs against the current tree before reusing them (see `AGENTS.md`).

Where things are:
- Lane worktrees: `/work/workspaces/orca/BibCode/lanes/<lane>`.
- Deferred patches and design drafts (outside the repo): `/work/workspaces/orca/BibCode/lanes/deferred-followups/`.

On 2026-09-27 the user said "stop doing follow ups unless critical". Everything below is non-critical, or unfinished feature work that was paused on purpose. The one critical item found late, the idle timer killing a running turn (F23), is fixed and ships in v0.7.0.

## 1. Unfinished feature work (committed on lane branches, not in v0.7.0)

### Remote server updates (plan Tasks 13-21)
- **Plan:** `docs/superpowers/plans/2026-09-24-remote-server-updates.md`.
- **Design:** `docs/superpowers/specs/2026-09-24-remote-server-updates-design.md`.
- **Branch:** `lane/task4`, worktree `lanes/task4`.
- **In v0.7.0 already:** Tasks 1-12 and 20a. This is the groundwork, with nothing new visible in the UI. It includes two real fixes: update protection now works while this host is shared, and an AppImage relaunch no longer keeps the old runtime alive.
- **Task 13, committed but NOT integrated:** `61f20cb0`, the Settings row update flow (confirmation dialog, progress, failure, Retry and Dismiss). It was live-verified in light and dark against the fake host.
- **Task 14, in progress and uncommitted** in `lanes/task4`: the sidebar card's update action, progress and failure.
- **Not started:**
  - 15: "Show update steps" for manual hosts.
  - 16: app-level notices (the host toast "Update requested from another device" and the browser reload prompt).
  - 17: the CI-only seeded `remote-install` lane.
  - 18: user docs and runbooks.
  - 19: gates.
  - 20: the live Playwright pass against the fake host (`apps/server/examples/remote_update_fake_host.rs` exists).
  - 21: UI.md and vercel reviews.
- **Integration notes:**
  - Rebase with `git rebase --onto <main> fce0f73f lane/task4`.
  - Desktop `updates.rs` uses `self.lock_inner()` for every lock site.
  - The relaunch tests use `test_support::isolated_scenario`.

### Staged chat uploads, design C (plan Tasks 2, 4, 5)
- **Plan:** `docs/superpowers/plans/2026-09-27-uploads-and-e2ee-transfers.md`.
- **Design:** `docs/superpowers/specs/2026-09-26-upload-liveness-design.md`.
- **Branch:** `lane/uploads`, worktree `lanes/uploads`.
- **Committed but NOT integrated:**
  - Task 1 `b56c1636`: the upload engine and the `uploads.begin/append/get/cancel` wire.
  - Task 3 `bfd45148`: the slow-uplink liveness harness.
  Nothing uses them yet, which is why they were held back.
- **Task 2, in progress and uncommitted:** binding staged uploads at turn start, and advertising `attachmentStaging`.
- **Not started:** Task 4 (the client stager with resume) and Task 5 (web progress and Cancel on the pending message, with the throttled live matrix).
- **Deferred by the user:** design B, E2EE file transfers (Tasks 6-13).
- **Integration notes:**
  - Rebase with `git rebase --onto <main> 777e9f8f lane/uploads`.
  - Regenerate the rpc-wire fixtures with `vp run check:contracts`; never hand-merge them.

## 2. Deferred follow-ups (non-critical)

| Id | What | Starting point |
|---|---|---|
| F24 | Retrying a delivery whose frozen session lost its resume state loops on "durable turn requires resumable runtime state". | Decided design: relaunch fresh with a mandatory notice ("Sent in a new conversation. The agent won't remember earlier messages in this thread."), and record `startedNewConversation` for any fresh start in a thread that has at least one completed turn and the same provider and instance. A user-initiated provider switch and a brand-new thread are excluded. Draft and fake Claude: `deferred-followups/f24-item7-design/`. |
| F21 | The web titles every `transport_error` session "BiBCode lost its connection to <provider>", even when BiBCode itself stopped it (restart reconciliation, workspace loss), so the title contradicts the body. | Server-provided classification with forward-compatible decoding (the `catchDecoding` idiom). Brief: `deferred-followups/lane-wire-followups-addendum-2.md`, item 08. |
| F29 | A repository opened broken never attaches automatic fetch after the repair (`spawn_fetch_attachment` resolves once). | An unreviewed, unverified Codex patch: `deferred-followups/deferred-f29-gitmanager.patch`. It flips one committed expectation in `assert_broken_repository_repair_is_watched`. |
| F30 | Test fixtures can inherit Git discovery and config environment (GIT_DIR, GIT_INDEX_FILE, GIT_CONFIG_*, and others). `cargo test` run from a git hook could touch the developer's repository. | Scrub the variables at the shared fixture helpers. Acceptance: run under a hostile environment and check that a scratch bare repository is untouched. |
| F33 | Flaky desktop test `backend::tests::start_racing_stop_cleans_late_backend_without_publishing_it` under heavy load. | An unverified patch (the sandbox couldn't bind sockets): `deferred-followups/deferred-f33-backend.patch`. Reproduce on the host first: 200 runs, 8 in parallel, under CPU load. |
| F34 | The production runtime runs a host-wide `sysinfo` `System::new_all()` process scan at every boot (about 1800 processes on the dev host). | Measure boot cost, then use a targeted refresh. |
| Guard | Hermetic test guard, Layer 2 (a test that resolves a real provider or hosting CLI aborts). Waves 1-2 fixed every known leak; the guard only prevents regressions. | Design: `docs/superpowers/specs/2026-09-26-hermetic-test-guard-design.md`. Refined notes (a single guard point in `git::process`, the ambient-PATH rule, allowed roots, rollout): `deferred-followups/hermetic-guard-notes.md` and `hermetic-guard-second-opinion.md`. |
| Orphans | Re-executed test children in their own process group (`run_child_with_deadline` in `tests/turn_delivery_recovery.rs`) survive Ctrl-C or SIGKILL of the parent. | Prefer an inherited-pipe watchdog that kills the child's group on EOF (covers descendants and macOS) over `PR_SET_PDEATHSIG`. |
| UI.md | The typography sweep (the 12 px floor and similar), deferred since the earlier font waves. | `UI.md`, `docs/architecture/overview.md`. |

## 3. Verification gaps in v0.7.0
- **F31, the Share This Host copy for a host without a private default route:** component-tested only. The live check needs a packaged desktop app in a network namespace without a default route.
- **The final light/dark screenshot pass on the final tree** was skipped to save usage. Every change was live-checked in its own lane.
- **Native Windows and macOS:** not run for this program. The Windows `safe.directory` quoting was checked with pwsh on Linux, and the macOS-only desktop test only compiles in macOS CI.

## 4. Residual risks recorded by the lanes (lower priority)

**Idle suspension (F23 fix), cases that stay live until the next turn or a stop:**
- a send that ends without a turn after the deadline was armed;
- a launched or restored session that never runs a turn;
- a failed turn.

Busy work that is never projected (an ambiguous delivery whose turn started, a failed `running` projection, a provider-initiated turn) is not seen by the idle check.

**Other lanes:**
- **Workspace-loss settlement:** a microsecond window remains in which a late delivery publication can still project `running`.
- **Git status stream:** `GitStatusBroadcaster.fellBehind` is duplicated in Rust and TS. Each side has its own test, but there is no cross-language parity test.
- **Desktop:** the restart guard's check-then-exit race is parked (it matches quitting mid-install today). The bridge IPC test still reads the host portal and `~/.ssh/config` read-only.
- **Provider supervisor suite:** `agent_activity_toggle_opencode_repeated_handoffs_return_to_one_stream` flaked once on the host and passed on reruns.
- **Unguarded CLI lookups:** with the guard deferred, a new `ServerConfig::new(tmp)` plus `ServerRuntime::start` without the hermetic helper silently resolves real CLIs again.
