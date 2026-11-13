# Progress: Issue batch #348 and #351 to #358

Plan: plan.md
Spec: spec.md (sha256 6ee666bd1646)
Plan status: Approved 2026-11-13
Plan review: Codex gpt-6.1-sol (effort high), round 2, needs rework; all 13 findings fixed without a third round, see reviews/plan-review-2.md
Executor: inline
Branch: claude/open-issues-pr-dc3c33

| Task | Title | Phase | State | Owner | Note |
|---|---|---|---|---|---|
| 1.1 | Repaint after a late font load | 1 | In progress | lane 1 | |
| 1.2 | Repaint a renderer created after host configuration | 1 | In progress | lane 1 | |
| 1.3 | Assert the repaint on a same-size return | 1 | In progress | lane 1 | |
| 1.4 | Development record of size and repaint decisions | 1 | In progress | lane 1 | |
| 1.5 | Say that the server kept the size when Fit sends nothing | 1 | In progress | lane 1 | |
| 1.6 | A dedicated hand-over capability | 1 | In progress | lane 1 | |
| 1.7 | Retry WebGL in a new terminal and say why it failed | 1 | In progress | lane 1 | |
| 1.8 | Decide whether a re-attach sends a transient size (R16) | 1 | In progress | lane 1 | |
| 1.9 | Decide whether the grid is taller than its mount before the first snapshot (R43) | 1 | In progress | lane 1 | |
| 1.10 | Count columns by Unicode 11 in every terminal | 1 | In progress | lane 1 | |
| 2.1 | Record the pull limit at takes_index_lock | 2 | In progress | lane 2 | |
| 2.2 | Record the hook limit at the forced-stop cleanup | 2 | In progress | lane 2 | |
| 2.3 | Anchor the sign-in detector to Git's fatal line | 2 | In progress | lane 2 | |
| 2.4 | Wait for running lookups at quiesce | 2 | In progress | lane 2 | |
| 2.5 | Remember a failed lookup for 5 seconds | 2 | In progress | lane 2 | |
| 2.6 | Stop showing a remembered pull request after a failed lookup on stale data | 2 | In progress | lane 2 | |
| 2.7 | Record the limit at spawn_for_subscribers | 2 | In progress | lane 2 | |
| 2.8 | Decide by test whether a status-neutral local change leaves a stale answer | 2 | In progress | lane 2 | |
| 3.1 | Make the drain test wait on the condition | 3 | In progress | lane 3 | |
| 3.2 | Delete creation records by id | 3 | In progress | lane 3 | |
| 3.3 | Audit both creation-rollback arms | 3 | In progress | lane 3 | |
| 3.4 | Reap a record only when its parent directory exists | 3 | In progress | lane 3 | |
| 3.5 | Record the limits in comments | 3 | In progress | lane 3 | |
| 4.1 | Hold a source registered during the install | 4 | In progress | lane 4 | |
| 4.2 | Restore the block when the window loads during an install | 4 | In progress | lane 4 | |
| 4.3 | Give the installing dialog a way out | 4 | In progress | lane 4 | |
| 4.4 | Decide whether the dialog hides the Manage devices toast | 4 | In progress | lane 4 | |
| 4.5 | Fail when a desktop event name exists on one side only | 4 | In progress | lane 4 | |
| 5.1 | Diagnose which path scrolls to the end after a programmatic scroll and a toggle | 5 | In progress | lane 5 | |
| 5.2 | Fix the first wrong decision the Ruling names | 5 | In progress | lane 5 | |
| 5.3 | Measure the Host dashboard values view's renders on the clock tick, and stop them only if there are any | 5 | Closed | lane 5 | on the lane branch, not integrated yet |
| 6.1 | Occlusion leases that carry a rectangle | 6 | Closed | lane 6 | on the lane branch, not integrated yet |
| 6.2 | Popups hold a rectangle lease only while open | 6 | Closed | lane 6 | on the lane branch, not integrated yet |
| 6.3 | The model picker reopens with an empty search | 6 | Closed | lane 6 | on the lane branch, not integrated yet |
| 6.4 | Read-only Markdown loads relative images from the workspace | 6 | Closed | lane 6 | on the lane branch, not integrated yet |
| 7.1 | Hide any read-only FUSE mount under a `.mount_` directory | 7 | In progress | lane 7 | |
| 7.2 | Check for a dead webview before every test and keep the whole recovery inside one deadline | 7 | In progress | lane 7 | |
| 7.3 | Run the flaky hint test 50 times under CPU load and diagnose any failure | 7 | In progress | lane 7 | |
| 7.4 | Log a rejected pairing offer and a rejected pairing credential at `warn` with a fixed class | 7 | In progress | lane 7 | |
| 8.1 | Linux lab run of the packaged list, with the webview-kill and route-change probes | 8 | Open | | |
| 8.2 | Mixed-version probe against the latest released server | 8 | Open | | |
| 8.3 | Windows VM runs | 8 | Open | | |
| 8.4 | Load runs on the Mac | 8 | Open | | |
| 9.1 | Profiler and validation references | 9 | Open | | |
| 9.2 | Architecture docs, runbooks and changelog | 9 | Open | | |
| 9.3 | Final gates and reviews | 9 | Open | | |
| 9.4 | Reviews before the push, then the pull request | 9 | Open | | |

## Log
- 2026-11-13 Plan written. Sources: ten issues exported to `sources/`, `evidence.md`, `triage.md`. #350 moved to `../2026-11-13-terminal-screen-350/` after its design review returned "needs rework".
- 2026-11-13 Baseline for Task 5.1 (plan decision P3): the packaged harness sets a 1000x720 viewport itself, and `chat-reasoning-rows` passed on Linux WebKitGTK in two full lab runs of the build that became `main` (31 passing each). No reproduction on Linux; the Windows VM (WebView2, device pixel ratio 2) is the signal.
- 2026-11-13 Plan approved under the user's standing pre-approval (two Codex reviews and the advisor's; 22 and 13 findings handled).
- 2026-11-13 08:35 Round 1 started. Executor: this session coordinates seven writer lanes (one per phase 1 to 7), each in its own worktree; tasks 1.1 to 7.4 In progress. Task 5.1's trace may need the Windows VM (Task 8.3 step 1).
- 2026-11-13 09:00 Ruling (user): the pull request is held until #350 lands; it must close all ten issues ("I want 0 issues in the repo"). Spec D2 and plan P1 amended; no task changes. Cost if wrong: none, the user decided.
- 2026-11-13 08:54 5.3 Closed (lane 5). Evidence: `HostDashboardSheet.test.tsx` 16 of 16; values view ran 3 times per 3 ticks before, 0 after. Commit 0f352ae19 on the lane branch. 5.1 waits for the Windows VM trace (instrumentation commit 71ce07520).
- 2026-11-13 08:58 6.1 to 6.4 Closed (lane 6). Evidence: phase checkpoint 32 files, 515 tests; full web unit suite 778 files, exit 0. Commits aef9efd41..10883408e on the lane branch. R46 verdict: real defect (search kept 'gpt' on reopen).
