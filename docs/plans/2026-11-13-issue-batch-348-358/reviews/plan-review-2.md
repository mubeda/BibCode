Verdict: **Needs rework.** All 41 active requirements have task assignments, but the revised plan still misses real caller behavior in the update guard and crash recovery. Several new test recipes would either pass without their change, remain red afterward, or hang.

Coverage: **requirement → tasks**

“Partial” identifies an incomplete scenario or proof. Mapping checked against `plan.md:108`; plan-file locations below are relative to `docs/plans/2026-11-13-issue-batch-348-358/`.

| Requirement | Tasks | Coverage |
|---|---|---|
| R1 | 1.1 | **Partial:** actual font measurement missing |
| R2 | 1.2 | Covered |
| R3 | 1.3 | Covered |
| R4 | 1.4 | Covered |
| R5 | 1.10, 9.2 | Covered |
| R6–R11 | — | Withdrawn; outside scope |
| R12 | 5.1, 5.2, 8.3; 8.1 regression guard | **Partial:** H3 proof and grouped-entry handling |
| R13 | 3.1, 8.3, 8.4 | Covered |
| R14 | 7.1 | Covered |
| R15 | 7.2, 8.1 | **Partial:** preceding failure hook can prevent recovery |
| R16 | 1.8 | Assigned conditional test/fix |
| R17 | 1.5 | Covered |
| R18 | 5.3 | **Proof gap:** counter cannot detect the parent render |
| R19 | 8.2 | Assigned probe |
| R20 | 8.1 | Assigned bounded probe |
| R21 | 2.1 | Covered |
| R22 | 2.2 | Covered |
| R23 | 2.3 | Covered |
| R24 | 9.1 | Covered |
| R25 | 9.1 | Covered |
| R26 | 2.4, 9.1 | **Partial:** concurrent admission and runtime wiring proof |
| R27 | 2.5 | **Proof gap:** cancellation regression can hang |
| R28 | 2.6 | Covered, including late refresh failure |
| R29 | 2.7 | Covered |
| R30 | 2.8 | Assigned conditional test/fix |
| R31 | 3.2 | Covered |
| R32 | 3.3, 9.1 | Covered |
| R33 | 3.4 | Covered |
| R34 | 3.5 | Covered |
| R35 | 4.2, 8.1 | **Partial:** real bridge converts failure into an apparent answer |
| R36 | 4.3 | **Partial:** same bridge problem |
| R37 | 4.1 | Covered |
| R38 | 4.5 | Covered |
| R39 | 4.4 | **Partial:** destination remains behind the installing modal |
| R40 | 6.1, 6.2 | Covered |
| R41 | 1.6, 9.2 | Covered |
| R42 | 1.7 | Covered |
| R43 | 1.9 | Assigned conditional test/fix |
| R44 | 7.3 | Assigned loaded runs and conditional diagnosis |
| R45 | 7.4 | **Proof gap:** log-capture and credential assertions |
| R46 | 6.3 | Covered |
| R47 | 6.4 | Covered |

No active requirement is wholly unassigned. No task is unrelated; Tasks 9.3 and 9.4 support verification and delivery.

Findings, most severe first:

| # | Severity | Location (file:line) | Issue | Evidence | Fix |
|---|---|---|---|---|---|
| 1 | Major | `phases/PHASE-04-update-install-guard.md:42` | **Round 1 #1 is not fully fixed through the real bridge.** A failed query can still release the restored block. | `getUpdateState` uses `tauriInvokeOr` (`apps/web/src/tauriDesktopBridge.ts:657`), which catches every rejection and returns its fallback (`:127`). That fallback has `requestedBy: null` (`:439`). The proposed fake-bridge rejection tests bypass this conversion. | Own the bridge and its tests. Preserve failure for supported state queries; distinguish genuine unsupported-query compatibility from operational failure. Test native invocation rejection through the real bridge. |
| 2 | Major | `phases/PHASE-01-terminal-panel-fixes.md:74` | The font listener repaints but does not reliably re-measure glyph metrics. | `scheduleResize` calls sizing and then atlas clearing/refresh (`apps/web/src/components/ThreadTerminalPanel.tsx:2834`). FitAddon reads cached cell dimensions (`apps/web/node_modules/@xterm/addon-fit/src/FitAddon.ts:62`); atlas clearing does not measure characters (`apps/web/node_modules/@xterm/xterm/src/browser/services/RenderService.ts:258`). The proposed test changes the mocked proposal directly (`PHASE-01:63`), bypassing the missing measurement. | Explicitly invalidate/re-measure font metrics before proposing dimensions, while preserving mirror geometry. Add a real-xterm measurement regression with unchanged mount dimensions. |
| 3 | Major | `phases/PHASE-02-git-and-pull-request-lookups.md:85` | Shutdown still has an admission-versus-registration race. | The proposed shutdown cancels/closes/waits outside `State`’s mutex. An admission can pass its closed check, pause before `tasks.spawn`, and register after shutdown observed an empty tracker. Current admission performs loading and spawning later in its critical section (`apps/server/src/source_control/open_pull_request_lookups.rs:181`, `:219`). The repository already solves this pattern by registering a tracking token under the admission lock (`apps/server/src/git/process.rs:845`). | Serialize closure of admission with task/token registration. Add a multithreaded gated test that pauses admission before registration and proves shutdown cannot finish early. |
| 4 | Major | `phases/PHASE-07-server-odds-and-e2e-harness.md:66` | The next `beforeTest` may never reach the new recovery probe after an actual test crashes its webview. | When the native app survives, `afterTest` still calls screenshot and page-source commands against the dead webview (`apps/desktop/e2e/wdio.conf.ts:211`). The runbook explicitly records that this hook failure causes subsequent tests to be skipped (`docs/testing/cross-platform-validation.md:673`). Task 8.1 kills the process **between** tests (`PHASE-08:33`), avoiding this failure path. | Make failure-evidence collection tolerate recognized dead-webview errors. Inject the crash during a failing test and prove its successor reaches recovery. |
| 5 | Major | `phases/PHASE-04-update-install-guard.md:56` | Task 4.2 cannot satisfy its own completion gate before Task 4.3. | Its test requires “Check again,” but Task 4.2 owns no dialog implementation (`:41`). Task 4.3 depends on 4.2 and adds that button (`:68`, `:82`). The existing dialog contains no button (`apps/web/src/components/files/UnsavedChangesCloseDialog.tsx:91`). | Move button assertions into 4.3, or deliver the button and its implementation together in 4.2. |
| 6 | Major | `phases/PHASE-05-reasoning-row-scroll-and-dashboard.md:47` | The new H3 test cannot turn green through the prescribed H3 fix. | H3 tests `MessagesTimeline` directly, while its fix changes `ChatView` state (`:59`). The timeline derives maintenance from its supplied `followsEnd` prop (`apps/web/src/components/chat/MessagesTimeline.tsx:754`); its standalone fixture’s toggle callback does nothing (`MessagesTimeline.test.tsx:248`). | Exercise the real `ChatView` toggle-to-prop path, exposing the resulting LegendList maintenance prop in that harness. |
| 7 | Major | `phases/PHASE-05-reasoning-row-scroll-and-dashboard.md:91` | The replacement render counter still does not prove R18. | The values component memoizes chart arrays and passes them to `HostMetricBars` (`apps/web/src/components/hostDashboard/HostDashboardSheet.tsx:222`, `:247`). An in-memory transform with the installed React Compiler confirmed that those JSX elements are cached by their chart-array references. A non-memoized mock wrapper therefore need not render when the values component renders. These tests run compiled (`docs/testing/README.md:224`). | Measure execution of the values component itself, or use a probe whose invocation cannot be hidden by child-JSX caching. Demonstrate failure before adding `memo` and after removing it. |
| 8 | Major | `phases/PHASE-05-reasoning-row-scroll-and-dashboard.md:57` | The proposed newest-thought predicate mistakes a grouped row for an individual reasoning entry. | Several consecutive work entries share one list row (`apps/web/src/components/chat/MessagesTimeline.logic.ts:1033`), and each reasoning entry renders its own toggle (`MessagesTimeline.tsx:1838`). In `[thought A, tool B, thought C]` inside the final work row, the proposed predicate considers A newest because no later **list row** exists. | Check entries following the reasoning ID within its group as well as subsequent rows. Add a grouped-entry case that preserves A’s header while retaining the newest-thought reveal. |
| 9 | Minor | `phases/PHASE-02-git-and-pull-request-lookups.md:112` | The “wiring test” does not test runtime wiring and does not retain the late refresh as claimed. | It invokes the service shutdown directly, without `ProductionRuntime::quiesce_for_update`. It also creates no subscriber, so the late future is dropped by `spawn_for_subscribers` (`apps/server/src/git/broadcaster.rs:943`). Removing the runtime shutdown call would leave this test passing. | Retain a subscriber and assert the child is alive before shutdown. Add a runtime-level test that fails when its lookup-shutdown call alone is removed. |
| 10 | Minor | `phases/PHASE-02-git-and-pull-request-lookups.md:135` | The cancellation regression waits forever for the behavior it should assert. | A wrongly stored failure leaves one entry, so the proposed `yield_now` loop never terminates. The current loader’s cancellation counter advances before cache settlement (`apps/server/src/source_control/open_pull_request_lookups.rs:366`); neither that counter nor entry removal is an independent completion signal. | Signal flight settlement separately, await it, then assert the entry count and retry behavior. Bound failed synchronization without relying on paused-clock auto-advance during a busy yield loop. |
| 11 | Minor | `phases/PHASE-07-server-odds-and-e2e-harness.md:113` | The pairing-log tests cannot provide their promised secret-leak proof as written. | Issuance generates credentials internally (`apps/server/src/auth/service.rs:1653`); it does not supply the promised marker prefix. Checking only that marker can miss logging the actual issued credential. Also, `with_default` is prescribed as an await-spanning guard (`PHASE-07:116`), whereas the cited existing harness uses `set_default` (`apps/server/tests/provider_terminal_supervisor.rs:4380`). | Assert absence of each actual issued credential. Use an await-spanning `set_default` guard on the current-thread test, or instrument the future with its subscriber. |
| 12 | Minor | `phases/PHASE-04-update-install-guard.md:104` | Navigating to Manage devices leaves its destination behind the installing modal. | The host persists beside the authenticated route outlet (`apps/web/src/routes/__root.tsx:229`), and continues rendering an always-open installing alert dialog while the install block exists (`apps/web/src/components/files/UnsavedChangesCloseDialog.tsx:93`, `:127`). Calling navigation changes the page beneath it; the proposed callback-only tests cannot prove device controls are usable. | Make device management accessible above/from the installing dialog while retaining Files save holds. Test interaction with the destination, not only callback invocation. |
| 13 | Nit | `progress.md:48` | Reworked task names are inconsistent, and one phase reference is stale. | Titles for 7.2, 8.1 and 8.2 differ from their phase files (`PHASE-07:42`; `PHASE-08:16`, `:38`; `progress.md:48`, `:51`, `:52`). Task 3.3 still says “Phase 13” documents its strings (`PHASE-03:74`). | Synchronize the three titles and change the documentation reference to Phase 9. |

What the plan got right:

- Preserve the resizing fit mock and mirror assertions in Task 1.1; the measurement fix must retain them (`PHASE-01:57`).
- Unicode 11 activation, `allowProposedApi`, and the real-xterm cursor test are coherent. Server width parity remains explicitly outside this plan (`PHASE-01:393`; `spec.md:96`).
- The late-failure callback, both hand-over gates, controlled picker reopening, popup movement tracking, and both rollback audit assertions are now explicitly covered (`PHASE-02:175`; `PHASE-01:232`; `PHASE-06:43`, `:65`; `PHASE-03:94`).
- The deliberate failure-cache and AppImage test rewrites match the binding spec. They should remain (`PHASE-02:139`; `PHASE-07:36`).
- Declared Round 1 source ownership has no direct collision: contracts/fixtures and the web manifest belong to Phase 1, popup primitives to Phase 6, and lockfile writes to the executor (`plan.md:81`, `:82`, `:94`, `:103`). No additional skill or task-size blocker found.

Open questions the plan cannot answer:

- Does the session marker survive the actual Linux web-process recovery? Task 8.1 correctly leaves this for native evidence (`PHASE-08:34`).
- Which R12 path actually scrolls on Windows? The live trace must still decide that before implementation (`PHASE-05:43`).
- After recovery times out, how will still-running operations be prevented from affecting subsequent tests? The new deadline explicitly abandons operations without cancelling them (`PHASE-07:47`).

Read-only verification included source tracing, spec-hash and task/title comparisons, and an in-memory compiler transform. No builds, suites, native runs, or file edits were performed; final Git checks preserved the initial state. Profiler review covered lookup shutdown ordering, rollback outcomes, and warning-log privacy; no profiler runtime evidence was collected.



## Handling

All 13 findings were accepted after a triage with the advisor; none contradicts a decision of the spec or the user. This was the second and last review round, so the fixes were not sent back for a third review. Recipe faults that remain will show at each task's red step and are logged as Rulings during execution.

- 1 (R35, Tasks 4.2, 4.3): fixed. Phase 4 now owns the `getUpdateState` entry of the web bridge: a rejection other than "the desktop does not know this command" is rethrown instead of becoming a fallback answer, the other callers are listed, and a test goes through the real bridge function.
- 2 (R1, Tasks 1.1, 1.2): fixed. Neither the new listener nor the existing bundled-font effect made xterm measure the font again. A helper re-measures the cell size before any size is proposed, a mirror keeps its grid, and a real-xterm test with an unchanged mount proves it. Spec R1 gained that scenario.
- 3 (Task 2.4): fixed. Admission closes and registers its tracking token under the same lock; a multithreaded gated test proves shutdown cannot finish early.
- 4 (Task 7.2): fixed. Failure-evidence collection tolerates a dead webview; the lab step (Task 8.1) now ends the web process during a failing test.
- 5 (Tasks 4.2, 4.3): fixed. The button assertions moved to Task 4.3.
- 6, 8 (Tasks 5.1, 5.2): fixed. The diagnosis ends at a logged verdict with one failing test through the real toggle path; the pre-written fix branches are gone; the grouped-row case is a spec scenario of R12.
- 7 (Task 5.3): fixed. The task measures the values view with a Profiler probe under the compiled build first; with no render on a tick it closes with no change. Spec R18 says so.
- 9, 10 (Phase 2): fixed. A runtime-level quiesce test fails when the shutdown call is removed; the cancellation test waits on an explicit settlement signal with a bounded wait.
- 11 (Task 7.4): fixed. Tests assert the absence of each issued credential under a guard that spans awaits.
- 12 (R39, Task 4.4): fixed. The task ends at the DOM test's verdict; the requirement for the defect case is in the spec (device management usable while the dialog is up).
- 13: fixed. Progress titles are regenerated from the phase files; the stale phase reference is corrected.
- Open questions: the marker's survival across a web-process relaunch and the scrolling path on Windows stay with Tasks 8.1 and 8.3, as the review agrees. Operations abandoned by the recovery deadline are not cancelled; Task 7.2 states it and the next probe detects a dead session.

Two rules were applied to every phase file beyond the listed findings: each Must task names the real boundary its behavior crosses and its test crosses it or names the lab step that does; and a diagnosis or decide-by-test task ends at a logged verdict, with any fix opened as a new task.
