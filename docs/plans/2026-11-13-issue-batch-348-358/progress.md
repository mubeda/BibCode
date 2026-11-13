# Progress: Issue batch #348 and #351 to #358

Plan: plan.md
Spec: spec.md (sha256 2df2631120ee)
Plan status: Draft
Plan review: none yet
Executor: none
Branch: claude/open-issues-pr-dc3c33

| Task | Title | Phase | State | Owner | Note |
|---|---|---|---|---|---|
| 1.1 | Repaint after a late font load | 1 | Open | | |
| 1.2 | Repaint a renderer created after host configuration | 1 | Open | | |
| 1.3 | Assert the repaint on a same-size return | 1 | Open | | |
| 1.4 | Development record of size and repaint decisions | 1 | Open | | |
| 1.5 | Say that the server kept the size when Fit sends nothing | 1 | Open | | |
| 1.6 | A dedicated hand-over capability | 1 | Open | | |
| 1.7 | Retry WebGL in a new terminal and say why it failed | 1 | Open | | |
| 1.8 | Decide whether a re-attach sends a transient size (R16) | 1 | Open | | |
| 1.9 | Decide whether the grid is taller than its mount before the first snapshot (R43) | 1 | Open | | |
| 1.10 | Count columns by Unicode 11 in every terminal | 1 | Open | | |
| 2.1 | Record the pull limit at takes_index_lock | 2 | Open | | |
| 2.2 | Record the hook limit at the forced-stop cleanup | 2 | Open | | |
| 2.3 | Anchor the sign-in detector to Git's fatal line | 2 | Open | | |
| 2.4 | Wait for running lookups at quiesce | 2 | Open | | |
| 2.5 | Remember a failed lookup for 5 seconds | 2 | Open | | |
| 2.6 | Stop showing a remembered pull request after a failed lookup on stale data | 2 | Open | | |
| 2.7 | Record the limit at spawn_for_subscribers | 2 | Open | | |
| 2.8 | Decide by test whether a status-neutral local change leaves a stale answer | 2 | Open | | |
| 3.1 | Make the drain test wait on the condition | 3 | Open | | |
| 3.2 | Delete creation records by id | 3 | Open | | |
| 3.3 | Audit both creation-rollback arms | 3 | Open | | |
| 3.4 | Reap a record only when its parent directory exists | 3 | Open | | |
| 3.5 | Record the limits in comments | 3 | Open | | |
| 4.1 | Hold a source registered during the install | 4 | Open | | |
| 4.2 | Restore the block when the window loads during an install | 4 | Open | | |
| 4.3 | Give the installing dialog a way out | 4 | Open | | |
| 4.4 | Decide whether the dialog hides the Manage devices toast | 4 | Open | | |
| 4.5 | Fail when a desktop event name exists on one side only | 4 | Open | | |
| 5.1 | Diagnose which path scrolls to the end after a programmatic scroll and a toggle | 5 | Open | | |
| 5.2 | Fix the first wrong decision the diagnosis names | 5 | Open | | |
| 5.3 | Stop the Host dashboard values view re-rendering on the clock tick | 5 | Open | | |
| 6.1 | Occlusion leases that carry a rectangle | 6 | Open | | |
| 6.2 | Popups hold a rectangle lease only while open | 6 | Open | | |
| 6.3 | The model picker reopens with an empty search | 6 | Open | | |
| 6.4 | Read-only Markdown loads relative images from the workspace | 6 | Open | | |
| 7.1 | Hide any read-only FUSE mount under a `.mount_` directory | 7 | Open | | |
| 7.2 | Check for a dead webview before every test and keep the relaunch inside the test allowance | 7 | Open | | |
| 7.3 | Run the flaky hint test 50 times under CPU load and diagnose any failure | 7 | Open | | |
| 7.4 | Log a rejected pairing offer and a rejected pairing credential at `warn` with a fixed class | 7 | Open | | |
| 8.1 | Linux lab run of the packaged list, with the two discriminating runs | 8 | Open | | |
| 8.2 | Mixed-version probe against the previous release's server | 8 | Open | | |
| 8.3 | Windows VM runs | 8 | Open | | |
| 8.4 | Load runs on the Mac | 8 | Open | | |
| 9.1 | Profiler and validation references | 9 | Open | | |
| 9.2 | Architecture docs, runbooks and changelog | 9 | Open | | |
| 9.3 | Final gates and reviews | 9 | Open | | |
| 9.4 | Reviews before the push, then the pull request | 9 | Open | | |

## Log
- 2026-11-13 Plan written. Sources: ten issues exported to `sources/`, `evidence.md`, `triage.md`. #350 moved to `../2026-11-13-terminal-screen-350/` after its design review returned "needs rework".
