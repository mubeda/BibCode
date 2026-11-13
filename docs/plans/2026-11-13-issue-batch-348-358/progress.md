# Progress: Issue batch #348 and #351 to #358

Plan: plan.md
Spec: spec.md (sha256 cd8779b5f2cb)
Plan status: Approved 2026-11-13
Plan review: Codex gpt-6.1-sol (effort high), round 2, needs rework; all 13 findings fixed without a third round, see reviews/plan-review-2.md
Executor: inline
Branch: claude/open-issues-pr-dc3c33

| Task | Title                                                                                                   | Phase | State       | Owner  | Note                             |
| ---- | ------------------------------------------------------------------------------------------------------- | ----- | ----------- | ------ | -------------------------------- |
| 1.1  | Repaint after a late font load                                                                          | 1     | Closed      | lane 1 | integrated                       |
| 1.2  | Repaint a renderer created after host configuration                                                     | 1     | Closed      | lane 1 | integrated                       |
| 1.3  | Assert the repaint on a same-size return                                                                | 1     | Closed      | lane 1 | integrated                       |
| 1.4  | Development record of size and repaint decisions                                                        | 1     | Closed      | lane 1 | integrated                       |
| 1.5  | Say that the server kept the size when Fit sends nothing                                                | 1     | Closed      | lane 1 | integrated                       |
| 1.6  | A dedicated hand-over capability                                                                        | 1     | Closed      | lane 1 | integrated                       |
| 1.7  | Retry WebGL in a new terminal and say why it failed                                                     | 1     | Closed      | lane 1 | integrated                       |
| 1.8  | Decide whether a re-attach sends a transient size (R16)                                                 | 1     | Closed      | lane 1 | integrated                       |
| 1.9  | Decide whether the grid is taller than its mount before the first snapshot (R43)                        | 1     | Closed      | lane 1 | integrated                       |
| 1.10 | Count columns by Unicode 11 in every terminal                                                           | 1     | Closed      | lane 1 | integrated                       |
| 2.1  | Record the pull limit at takes_index_lock                                                               | 2     | Closed      | lane 2 | integrated                       |
| 2.2  | Record the hook limit at the forced-stop cleanup                                                        | 2     | Closed      | lane 2 | integrated                       |
| 2.3  | Anchor the sign-in detector to Git's fatal line                                                         | 2     | Closed      | lane 2 | integrated                       |
| 2.4  | Wait for running lookups at quiesce                                                                     | 2     | Closed      | lane 2 | integrated                       |
| 2.5  | Remember a failed lookup for 5 seconds                                                                  | 2     | Closed      | lane 2 | integrated                       |
| 2.6  | Stop showing a remembered pull request after a failed lookup on stale data                              | 2     | Closed      | lane 2 | integrated                       |
| 2.7  | Record the limit at spawn_for_subscribers                                                               | 2     | Closed      | lane 2 | integrated                       |
| 2.8  | Decide by test whether a status-neutral local change leaves a stale answer                              | 2     | Closed      | lane 2 | integrated                       |
| 3.1  | Make the drain test wait on the condition                                                               | 3     | In progress | lane 3 |                                  |
| 3.2  | Delete creation records by id                                                                           | 3     | In progress | lane 3 |                                  |
| 3.3  | Audit both creation-rollback arms                                                                       | 3     | In progress | lane 3 |                                  |
| 3.4  | Reap a record only when its parent directory exists                                                     | 3     | In progress | lane 3 |                                  |
| 3.5  | Record the limits in comments                                                                           | 3     | In progress | lane 3 |                                  |
| 4.1  | Hold a source registered during the install                                                             | 4     | Closed      | lane 4 | integrated                       |
| 4.2  | Restore the block when the window loads during an install                                               | 4     | Closed      | lane 4 | integrated                       |
| 4.3  | Give the installing dialog a way out                                                                    | 4     | Closed      | lane 4 | integrated                       |
| 4.4  | Decide whether the dialog hides the Manage devices toast                                                | 4     | Closed      | lane 4 | integrated                       |
| 4.5  | Fail when a desktop event name exists on one side only                                                  | 4     | Closed      | lane 4 | integrated                       |
| 5.1  | Diagnose which path scrolls to the end after a programmatic scroll and a toggle                         | 5     | Closed      | lane 5 | integrated; Windows proof 3 of 3 |
| 5.2  | Fix the first wrong decision the Ruling names                                                           | 5     | Closed      | lane 5 | integrated; Windows proof 3 of 3 |
| 5.3  | Measure the Host dashboard values view's renders on the clock tick, and stop them only if there are any | 5     | Closed      | lane 5 | integrated                       |
| 6.1  | Occlusion leases that carry a rectangle                                                                 | 6     | Closed      | lane 6 | integrated                       |
| 6.2  | Popups hold a rectangle lease only while open                                                           | 6     | Closed      | lane 6 | integrated                       |
| 6.3  | The model picker reopens with an empty search                                                           | 6     | Closed      | lane 6 | integrated                       |
| 6.4  | Read-only Markdown loads relative images from the workspace                                             | 6     | Closed      | lane 6 | integrated                       |
| 7.1  | Hide any read-only FUSE mount under a `.mount_` directory                                               | 7     | Closed      | lane 7 | integrated; 7.2 lab proof in 8.1 |
| 7.2  | Check for a dead webview before every test and keep the whole recovery inside one deadline              | 7     | Closed      | lane 7 | integrated; 7.2 lab proof in 8.1 |
| 7.3  | Run the flaky hint test 50 times under CPU load and diagnose any failure                                | 7     | Closed      | lane 7 | integrated; 7.2 lab proof in 8.1 |
| 7.4  | Log a rejected pairing offer and a rejected pairing credential at `warn` with a fixed class             | 7     | Closed      | lane 7 | integrated; 7.2 lab proof in 8.1 |
| 8.1  | Linux lab run of the packaged list, with the webview-kill and route-change probes                       | 8     | Open        |        |                                  |
| 8.2  | Mixed-version probe against the latest released server                                                  | 8     | Open        |        |                                  |
| 8.3  | Windows VM runs                                                                                         | 8     | Open        |        |                                  |
| 8.4  | Load runs on the Mac                                                                                    | 8     | Open        |        |                                  |
| 9.1  | Profiler and validation references                                                                      | 9     | Open        |        |                                  |
| 9.2  | Architecture docs, runbooks and changelog                                                               | 9     | Open        |        |                                  |
| 9.3  | Final gates and reviews                                                                                 | 9     | Open        |        |                                  |
| 9.4  | Reviews before the push, then the pull request                                                          | 9     | Open        |        |                                  |

## Log

- 2026-11-13 Plan written. Sources: ten issues exported to `sources/`, `evidence.md`, `triage.md`. #350 moved to `../2026-11-13-terminal-screen-350/` after its design review returned "needs rework".
- 2026-11-13 Baseline for Task 5.1 (plan decision P3): the packaged harness sets a 1000x720 viewport itself, and `chat-reasoning-rows` passed on Linux WebKitGTK in two full lab runs of the build that became `main` (31 passing each). No reproduction on Linux; the Windows VM (WebView2, device pixel ratio 2) is the signal.
- 2026-11-13 Plan approved under the user's standing pre-approval (two Codex reviews and the advisor's; 22 and 13 findings handled).
- 2026-11-13 08:35 Round 1 started. Executor: this session coordinates seven writer lanes (one per phase 1 to 7), each in its own worktree; tasks 1.1 to 7.4 In progress. Task 5.1's trace may need the Windows VM (Task 8.3 step 1).
- 2026-11-13 09:00 Ruling (user): the pull request is held until #350 lands; it must close all ten issues ("I want 0 issues in the repo"). Spec D2 and plan P1 amended; no task changes. Cost if wrong: none, the user decided.
- 2026-11-13 08:54 5.3 Closed (lane 5). Evidence: `HostDashboardSheet.test.tsx` 16 of 16; values view ran 3 times per 3 ticks before, 0 after. Commit 0f352ae19 on the lane branch. 5.1 waits for the Windows VM trace (instrumentation commit 71ce07520).
- 2026-11-13 08:58 6.1 to 6.4 Closed (lane 6). Evidence: phase checkpoint 32 files, 515 tests; full web unit suite 778 files, exit 0. Commits aef9efd41..10883408e on the lane branch. R46 verdict: real defect (search kept 'gpt' on reopen).
- 2026-11-13 09:06 4.1 to 4.5 Closed (lane 4), integrated by merge. Evidence: phase unit tests 32 files, 328 passed; `scripts/desktop-event-names.test.ts` 1 passed; web typecheck exit 0. R39 verdict: no defect (the toast action stays reachable over the installing dialog; happy-dom checks attributes only). Follow-up fixed: "Check again" now reports a still-running install or an unreachable app (commit f341022a5).
- 2026-11-13 09:17 5.1 trace (Windows 11 arm64 VM, 1000x720, device pixel ratio 2): `chat-reasoning-rows` failed with Expected <= 2, Received 1014. The scroll came from `followTimelineLiveEnd` (caller `liveFollow`) about 150 ms after the toggle, at scroll 0, mode `anchoring-new-turn`. The toggle reveal (`needsReveal` false), the grown-turn follow (`follows` false) and the list's end maintenance (`maintainScrollAtEnd` false) did not scroll. Profiler was not on for this trace run.
- 2026-11-13 09:30 5.1 and 5.2 Closed (lane 5), integrated by cherry-pick (972442af9, 707d9cba7; the instrumentation commit and its revert were left out). Verdict R12: the first wrong decision is `onIsAtEndChange(false)` returning early when the follow generations are equal, so a scroll away that no gesture made never stops following; the next streamed entry then reveals the end. It is a timing condition, not a Windows one. Ruling: a work group renders one list row per visible step, so the spec's grouped-row scenario is met by passing the entry id and revealing only for the newest step.
- 2026-11-13 09:28 7.1 to 7.4 Closed (lane 7), integrated by merge. Evidence: `host_metrics::volumes` 16 passed; `app-lifecycle.test.ts` 26 passed; `auth::http` 4 and the credential tests 2 passed; `--test auth_http` 35 passed; fmt and Clippy exit 0. R44: 0 failures in 50 runs under load (load average about 28), no code change. Ruling: hook-order tests parse `wdio.conf.ts` with the oxc parser because TypeScript 7 has no `createSourceFile`.
- 2026-11-13 09:43 1.1 to 1.10 Closed (lane 1), integrated by merge. Evidence: phase web tests 8 files, 415 passed; contracts 39 passed; `check:contracts` exit 0; cargo descriptor tests 2 passed; typecheck, fmt, Clippy exit 0. R16 verdict: defect (claims `85x33` then `85x30` on re-attach), fixed by putting a re-measured cell through the settle window; the same fix was applied to the pixel-ratio and bundled-font paths as a follow-up (4930b0e7d). R43 verdict: no defect. Ruling: the WebGL warning names a stage and an error type only.
- 2026-11-13 09:53 2.1 to 2.8 Closed (lane 2), integrated by merge. Evidence: checkpoint 79 passed across six filters; fmt and Clippy exit 0. Quiesce step name: `pull-request-lookups` (after `status-broadcaster`, before `git-writes`). R30 verdict: defect (a status-neutral local change left the outdated answer with no follow-up lookup), fixed as an added task. Follow-up open: whether an HTTP-based lookup aborts promptly at shutdown.
- 2026-11-13 09:54 R12 Windows proof (part of 8.3): fix commit 707d9cba7 built in the VM; `chat-reasoning-rows` passed 3 of 3; the packaged default list passed (37 passing, 4 skipped, 0 failing). Profiler on: no finding in the three runs; three `rpc.slow` warnings in the default list (`gitManager.stagePartial` 1.2 s twice, `vcs.listRefs` 1.5 s three times), pre-existing, unrelated to scrolling.
- 2026-11-13 10:39 Ruling (user): "350 close it as not planned". The pull request closes the other nine issues and no longer waits for #350. The serializer proof was stopped during its resize work; its project is archived outside the repository. Spec D2 and plan P1 amended; no task changes. Cost if wrong: none, the user decided.
