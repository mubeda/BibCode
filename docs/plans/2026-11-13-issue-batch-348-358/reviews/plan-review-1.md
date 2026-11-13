Verdict: **Needs rework.** All 41 active requirements have task assignments, and the main ownership boundaries are sensible. However, the plan contradicts R35, misses lookup lifecycle paths, and includes diagnostic tests that could produce false conclusions or remain red after their prescribed fixes.

Coverage: **requirement → tasks**

“Partial” means a scenario, caller, or necessary proof is missing—not that the requirement has no assignment. Mapping source: `docs/plans/2026-11-13-issue-batch-348-358/plan.md:108`.

| Requirement | Tasks | Assessment |
|---|---|---|
| R1 | 1.1 | Covered: owner, mirror, legacy, unmount |
| R2 | 1.2 | Covered: delayed creation and disposed renderer |
| R3 | 1.3 | Covered |
| R4 | 1.4 | Assigned; verification filter needs correction |
| R5 | 1.10, 9.2 | Covered; server width parity explicitly outside scope |
| R6–R11 | — | Withdrawn; no gap |
| R12 | 5.1, 5.2, 8.1, 8.3 | **Partial:** flawed diagnostics; independent viewport variation unassigned |
| R13 | 3.1, 8.3, 8.4 | Covered: injected delay, 50 loaded runs, 12 Windows suite runs |
| R14 | 7.1 | Covered, including intentional old-test changes |
| R15 | 7.2 | **Partial:** timeout arithmetic does not bound the complete recovery |
| R16 | 1.8 | Covered by conditional test/fix |
| R17 | 1.5 | Covered |
| R18 | 5.3 | Covered |
| R19 | 8.2 | Assigned; prescribed command fails |
| R20 | 8.1 | Assigned bounded probe |
| R21 | 2.1 | Covered by recorded limit |
| R22 | 2.2 | Covered by recorded limit and existing test |
| R23 | 2.3 | Covered, including both caller inputs and carriage returns |
| R24 | 9.1 | Covered |
| R25 | 9.1 | Covered |
| R26 | 2.4, 9.1 | **Partial:** shutdown misses flights outside cache entries |
| R27 | 2.5 | Assigned; cancellation/time-control proof needs correction |
| R28 | 2.6 | **Partial:** late refresh failures omitted |
| R29 | 2.7 | Covered by recorded limit |
| R30 | 2.8 | Covered by conditional test/fix |
| R31 | 3.2 | Assigned; prescribed mutation does not prove the regression |
| R32 | 3.3, 9.1 | **Partial:** audit assertions do not cover both rollback callers |
| R33 | 3.4 | Covered: missing parent, existing parent, parent disappearing |
| R34 | 3.5 | Covered by recorded limits |
| R35 | 4.2 | **Conflict:** first failed reload query permits saving |
| R36 | 4.3 | Covered |
| R37 | 4.1 | Covered |
| R38 | 4.5 | Assigned; scanner produces a false mismatch |
| R39 | 4.4 | **Partial:** defect branch names the wrong host mounting location |
| R40 | 6.1, 6.2 | **Partial:** position-only popup movement omitted |
| R41 | 1.6, 9.2 | **Partial:** another hand-over decision bypasses the capability |
| R42 | 1.7 | Covered |
| R43 | 1.9 | Covered by conditional test/fix |
| R44 | 7.3 | Covered by loaded runs and conditional diagnosis |
| R45 | 7.4 | Assigned; promised in-memory rejection classification is unavailable |
| R46 | 6.3 | **Partial:** controlled openings bypass the proposed reset |
| R47 | 6.4 | Assigned; existing test mocks prevent the prescribed caller proof |

No active requirement is wholly unassigned. No task is entirely unrelated: Tasks 9.3 and 9.4 support the spec’s verification and delivery requirements.

**Findings, most severe first**

Phase-file locations below are relative to `docs/plans/2026-11-13-issue-batch-348-358/`.

| # | Severity | Location (file:line) | Issue | Evidence | Fix |
|---|---|---|---|---|---|
| 1 | Major | `phases/PHASE-04-update-install-guard.md:44` | Task 4.2 contradicts R35 during the dangerous reload interval. | `spec.md:206` requires saving to stay held after the first query rejects. Task 4.2 explicitly holds nothing before an answer and tests that nothing is blocked at `PHASE-04:54`. | Preserve evidence that this window allowed an install across reload, and retain the hold until a confirmed non-running state. Test edits/autosave during the first rejection and timeout. |
| 2 | Major | `phases/PHASE-02-git-and-pull-request-lookups.md:104` | Tracking every flight does not cancel every flight. | The implementation stores cancellation tokens only in `Slot::InFlight`. Invalidation removes those entries (`apps/server/src/source_control/open_pull_request_lookups.rs:170`), and capacity overflow starts flights without inserting entries (`:206`). Shutdown can therefore wait on a flight whose cancellation it cannot reach. Also, the existing result forwarding returns the loader’s error, not the planned waiter’s `None` (`:159`, `:224`). | Give every flight a shutdown cancellation ancestor independent of cache membership. Define cancelled completion explicitly. Add shutdown tests for an invalidated flight, capacity overflow, and a retained waiter. |
| 3 | Major | `phases/PHASE-02-git-and-pull-request-lookups.md:164` | Task 2.6 misses failures arriving after the refresh timeout. | The late callback handles only successful lookup answers (`apps/server/src/production/git_vcs.rs:949`). An existing test explicitly exercises a refresh whose lookup runs without another stream lookup (`:9093`). The plan changes the immediate unary and stream completion sites only. | Handle uncancelled failure in the late callback too. Add a stale-request test where that late lookup fails and the subscriber clears the request. |
| 4 | Major | `phases/PHASE-05-reasoning-row-scroll-and-dashboard.md:44` | H3 can “confirm” a path that is already disabled. | The test equates `followsEnd === true` with enabled LegendList maintenance. The actual predicate returns `false` whenever anchored, regardless of `followsEnd` (`apps/web/src/components/chat/MessagesTimeline.logic.ts:43`); the component supplies both inputs (`MessagesTimeline.tsx:754`). | Diagnose the actual `maintainScrollAtEnd` value and resulting list behavior. A boolean captured from a mocked child is insufficient attribution. |
| 5 | Major | `phases/PHASE-05-reasoning-row-scroll-and-dashboard.md:43` | The H2 failing test cannot be fixed by the prescribed H2 change. | H2 deliberately never calls `onReasoningRowToggle`. Its proposed fix depends on a row-ID ref set by that callback (`PHASE-05:55`). Furthermore, row-ID plumbing is allocated only to H1, while existing callback contracts take no arguments (`apps/web/src/components/chat/MessagesTimeline.tsx:199`, `:311`). | Separate a growth-path diagnostic from a toggle regression. Exercise the real toggle before testing the guard; include callback types/caller changes for H2 too. Update fixture rows and calls while preserving the #173 assertion—its current fixture contains anonymous rows and invokes the callback without an ID (`ChatView.test.tsx:5543`, `:5592`). |
| 6 | Major | `phases/PHASE-01-terminal-panel-fixes.md:161` | Replacing only the `resized` assignment does not fully gate hand-over behavior. | `applySize` independently sets `unownedUntilUsed` through `isUnownedUntilUsed(size)` (`apps/web/src/components/ThreadTerminalPanel.tsx:1904`). That helper checks `replyClaim`, without consulting capabilities (`terminalSizePolicy.ts:60`). | Gate every entry into the hand-over state with `sizeHandOver`. Include snapshots/attachments carrying `replyClaim` with the capability absent or false. |
| 7 | Major | `phases/PHASE-06-popups-picker-and-markdown-images.md:65` | The picker reset misses the composer’s controlled keyboard openings. | The proposed counter increments only in `setIsMenuOpen`. Controlled state comes directly from `props.open` (`apps/web/src/components/chat/ProviderModelPicker.tsx:44`), and the composer opens it directly through its imperative handle (`ChatComposer.tsx:2250`) while passing controlled `open` (`:2911`). | Reset on the actual closed-to-open transition, including external prop changes. Test typing, closing, then reopening through the composer’s controlled path. |
| 8 | Major | `phases/PHASE-06-popups-picker-and-markdown-images.md:43` | Popup leases become stale when a popup moves without resizing. | The proposed geometry updates observe size and window resize only. A positioner can move through anchor scrolling or positioning updates while keeping its dimensions; the existing popover explicitly transitions positional properties (`apps/web/src/components/ui/popover.tsx:44`). | Subscribe to positioning/scroll changes or an equivalent geometry signal. Test movement into and out of overlap without a size change. |
| 9 | Major | `phases/PHASE-07-server-odds-and-e2e-harness.md:47` | The claimed recovery worst case excludes potentially long operations. | Recovery includes the initial WebDriver probe, `reloadSession`, and mock restoration (`apps/desktop/e2e/support/app-lifecycle.ts:272`, `:279`, `:348`). WDIO permits a command to wait 120 seconds (`wdio.conf.ts:165`), already exceeding the proposed 20-second margin. The test merely sums constants. | Enforce one deadline across the complete recovery and test delayed operations. Add a test of the `beforeTest` registration; calling the existing recovery helper twice does not detect an omitted hook. |
| 10 | Major | `phases/PHASE-07-server-odds-and-e2e-harness.md:95` | The claimed in-memory `revoked` classification cannot be recovered through the prescribed flow. | Revocation removes the in-memory pairing (`apps/server/src/auth/service.rs:2088`). A later credential lookup therefore sees no record (`:3088`), so the test at `PHASE-07:106` cannot distinguish revoked from unknown. | Promise only classifications available in each storage mode. Reporting `unknown` for removed in-memory records satisfies R45 without introducing retention solely for logging. |
| 11 | Major | `phases/PHASE-06-popups-picker-and-markdown-images.md:74` | Two prescribed tests cannot reach the behavior they claim to prove. | The picker test replaces `ModelPickerContent` with a component containing no search input (`apps/web/src/components/chat/ProviderModelPicker.test.tsx:94`). The Files test replaces `ChatMarkdown` with a text-only div (`files/FilePreviewPanel.test.tsx:368`), preventing any image from reaching the loader required at `PHASE-06:96`. | Explicitly change the harnesses or add integration tests using the real components. Keep prop-forwarding assertions separate from actual search/image behavior. |
| 12 | Major | `phases/PHASE-03-worktree-records-and-removal-test.md:81` | R32 lacks audit proof for the record-write rollback, and the new profiler test risks global-state interference. | The audit assertion exercises dispatch failure only. The integration file expressly keeps all scenarios in one test because the profiler is process-global (`apps/server/tests/profiler_worktree_audit.rs:1`). | Extend that existing test with both rollback arms and relevant outcome assertions. Each production audit call must have a test that fails when that call alone is removed. |
| 13 | Minor | `phases/PHASE-04-update-install-guard.md:101` | The toast defect branch routes its callback through the wrong mounting location. | `AppRoot` mounts the notifier (`apps/web/src/AppRoot.tsx:170`), but the close host is mounted in the root route, including several gate states (`apps/web/src/routes/__root.tsx:194`, `:205`, `:229`, `:316`). Those files are absent from Task 4.4’s edit set. | Name and own the actual host callers and routing tests in the conditional branch. |
| 14 | Minor | `phases/PHASE-08-labs-and-probes.md:51` | The mixed-version probe stops at its first command. | Running the exact command reports “Missing required flag: --channel.” Both channel and current tag are required (`scripts/resolve-previous-release-tag.ts:362`, `:365`); output is `previous_tag=…` (`:332`). | Supply concrete flag derivation and parse the output. Specify the release asset, isolated startup/authentication, and exact runtime calls needed by the scratch probe. |
| 15 | Minor | `phases/PHASE-02-git-and-pull-request-lookups.md:130` | Backoff proof lacks necessary time and settlement control. | The rewritten existing test uses `advance`, but currently has an unpaused `#[tokio::test]` (`apps/server/src/source_control/open_pull_request_lookups.rs:435`). The cancellation test also does not require the old flight to settle before retry; a new admission can replace its identity (`:196`), hiding a broken cancellation-storage rule. | Explicitly pause the existing test and wait for cancelled-flight settlement before resolving again. |
| 16 | Minor | `phases/PHASE-03-worktree-records-and-removal-test.md:60` | The proposed SQL mutation does not make the recreation test fail. | `INSERT OR REPLACE` removes the old record (`apps/server/src/persistence/repositories.rs:321`). The mutant’s subquery for that old ID consequently returns no path and deletes nothing. An in-memory SQLite probe confirmed the replacement survives. | Mutate the removal caller back to deleting its captured path, then demonstrate that the handler test deletes the replacement record. |
| 17 | Minor | `phases/PHASE-02-git-and-pull-request-lookups.md:102` | Ignoring TERM does not inject delayed forge cleanup through this runner. | Forge commands use the process runner (`apps/server/src/source_control/pull_request.rs:1465`), whose non-Git stop policy is `Force` (`apps/server/src/git/process.rs:946`). | Inject delayed completion/cleanup through a runner seam or synchronization gate. Do not rely on a TERM trap to establish the 200 ms shutdown condition. |
| 18 | Minor | `phases/PHASE-01-terminal-panel-fixes.md:113` | Several verification recipes cannot produce their stated result. | The diagnostics filter excludes the three ring-test titles at `PHASE-01:118`. The shutdown prefix at `PHASE-02:93` selects only two of its three named tests. The File map command at `plan.md:84` is rejected by Cargo for its second positional filter; this was reproduced without running tests. | Correct selectors, use `--` for multiple libtest filters, and make working directories explicit. |
| 19 | Minor | `phases/PHASE-09-docs-gates-and-pull-request.md:47` | Documentation tasks leave directly contradicted living statements behind. | The overview says failures are never reused (`docs/architecture/overview.md:177`) and gates hand-over on `terminalUserInputClaim` (`:1576`). The shared testing runbook describes worker-only recovery and cascading failures (`docs/testing/cross-platform-validation.md:667`). The planned edits do not name these updates. | Explicitly update lookup backoff/expiry, the overview’s capability rule, and shared harness documentation. |
| 20 | Minor | `phases/PHASE-05-reasoning-row-scroll-and-dashboard.md:40` | R12’s independent viewport experiment has no task. | `spec.md:104` requires varying viewport independently. Phase 5 and Task 8.1 schedule only the 1000×720 run. Shared setup also sets that size itself (`apps/desktop/e2e/support/ui-state.ts:70`). | Add a second measured viewport run and a way to apply it after shared setup. Record actual CSS dimensions. |
| 21 | Minor | `phases/PHASE-02-git-and-pull-request-lookups.md:143` | The named broadcaster type does not exist. | The existing type is `StatusBroadcaster` (`apps/server/src/git/broadcaster.rs:35`), not `GitBroadcaster`. | Correct the Interfaces names, including the proposed test setter. |
| 22 | Minor | `phases/PHASE-09-docs-gates-and-pull-request.md:70` | The final task substitutes weaker checks for the binding whole-tree gate. | The spec requires successful `vp check` (`spec.md:251`); the task runs whole-tree `vp check --no-fmt` plus formatting checks on changed files. | Run the required command, or explicitly resolve the spec discrepancy before claiming completion. |

Dependencies and parallelism: I found no direct round-one source-file collision in the declared ownership sets. The contracts fixtures and web manifest belong to Phase 1, popup primitives to Phase 6, and lockfile writes to the executor (`plan.md:81`, `:82`, `:94`, `:103`). Preserve separate lane build directories. The important missing dependency is inside Task 5.2: H2 needs the row-ID plumbing currently assigned only to H1.

Task-size judgment: comment-only Tasks 2.1 and 2.2 are too small to warrant separate reviews of the same file; Task 1.3 can accompany the related repaint tests. Conversely, Task 8.3 should checkpoint its build, static gates, packaged result, and each completed suite run so its hours-long measurement can resume independently (`PHASE-08:57`). The named skills generally fit the work; the substantive problems are the recipes and caller coverage.

Consistency: all **47 task IDs and titles** match `progress.md`, and the spec hash matches `2df2631120ee`. Phase 9’s checkpoint nevertheless refers to Task 9.2’s commands where it appears to mean 9.3 (`PHASE-09:10`).

**What the plan got right**

- Task 1.1 preserves mirror geometry by proposing dimensions without fitting locally, and its resizing fit mock can catch accidental reflow (`PHASE-01:23`, `:36`).
- Task 1.10 correctly accounts for `allowProposedApi`, real-xterm width assertions, and the existing fake addon lifecycle. Server width parity remains explicitly outside this plan (`PHASE-01:275`, `:290`; `spec.md:96`).
- The proposed quiesce position and obtaining the final built service instance are sound choices (`PHASE-02:87`, `:105`).
- Rewriting the old failure-cache and AppImage assertions is intentional and justified by the binding spec (`PHASE-02:130`; `PHASE-07:14`).
- Capturing creation IDs and checking the parent directory again at reap time preserve the intended race and unmounted-volume protections (`PHASE-03:45`, `:93`).

**Open questions the plan cannot answer**

- What surviving signal identifies a reload during an allowed install, so R35 can hold saving while its first query fails?
- What reproducible recipe creates the named Linux lab image when absent? The cited workflow provides native-runner setup, not that image’s construction (`PHASE-08:21`; `.github/workflows/desktop-ui-smoke.yml:18`).
- What exact automated scenario kills a webview and proves the next test recovers? Phase 7 promises that later evidence, but Phase 8 does not schedule the injection (`PHASE-07:10`; `PHASE-08:30`).

No files changed. Validation was limited to source inspection, in-memory probes, task/hash comparison, and the two failing command-parser checks described above; no builds, suites, or native runs were performed.
