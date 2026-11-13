Reviewed through `c7080c1a5`, including the commit that arrived during review. **Scope caveat:** local `main...HEAD` contains 459 files. The review below covers the intended 79-file batch against `origin/main` (`a9938193b`), which matches the spec’s baseline.

| #   | Severity | file:line                                                                                                  | Issue                                                                      | Failing scenario and how to reproduce                                                                                                                                                                                                                                                                                               | Fix                                                                                                                                                |
| --- | -------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Major    | [UnsavedChangesCloseDialog.test.tsx:971](apps/web/src/components/files/UnsavedChangesCloseDialog.test.tsx) | **R39’s test proves a click, but device management remains inaccessible.** | Allow a remote install, then click **Manage devices**. The production callback in `AppRoot.tsx:172` navigates to Settings underneath the persistent installing modal. Settings remains inaccessible. The test substitutes a spy and stops after checking that it ran—the exact incomplete behavior R39 excludes.                    | Exercise the real navigation destination. Present usable device management above the installing dialog while retaining Files save holds.           |
| 2   | Minor    | [app-lifecycle.ts:248](apps/desktop/e2e/support/app-lifecycle.ts)                                          | **An expired recovery deadline still admits work and can report success.** | Pass a deadline whose `remainingMs()` returns `0` to `prepareRelaunchedDesktopUiSession`. With immediately resolving steps, all four run successfully. I reproduced this in memory. The zero-delay timer loses to promise microtasks; a recovery crossing its deadline can consequently start later operations.                     | Reject before invoking an operation when no time remains; check expiration before launching the replacement process. Add an expired-at-entry test. |
| 3   | Minor    | [HostDashboardSheet.tsx:227](apps/web/src/components/hostDashboard/HostDashboardSheet.tsx)                 | **R18 still rerenders the values view on clock-only changes.**             | Keep the metrics snapshot unchanged with server uptime at 10 seconds, then advance the clock one second. `values.since` changes from “up 10s” to “up 11s”, so the comparator returns false. This repeats during the first minute and at subsequent duration boundaries. The added test fixes `nowMs` throughout, so it misses this. | Separate the ticking uptime label from the values view. Test the parent’s actual timer with an unchanged snapshot.                                 |

**Requirements without complete evidence**

- **R13:** found the revised drain test, but no recorded 2.5-second red/green demonstration, 50 Mac load passes, or 12 Windows whole-suite passes.
- **R19:** no recorded previous-release server probe.
- **R20:** no recorded ten-route-change Linux profiler result.
- **R15/R35:** unit coverage exists, but the planned packaged web-process-kill/recovery and marker-survival evidence remains unrecorded.
- **R18/R39:** the existing tests do not establish the required outcomes, as described above.

These lab tasks remain open in [progress.md:51](docs/plans/2026-11-13-issue-batch-348-358/progress.md). R6–R11 are withdrawn; I did not treat #350 as unfinished scope.

**What looks right**

- Terminal remeasurement reaches xterm’s installed private service, with a real-xterm compatibility test. Mirrors retain server geometry; automatic sizing uses the settle/max-wait rules. Unicode 11, capability gating, WebGL recreation, and Fit feedback have focused coverage.
- Disabled diagnostics create no per-event records or terminal-content records. They **do allocate the 200-slot array once** at module initialization.
- Lookup admission and shutdown share the lock; task tracking covers invalidated and uncached flights. Cancellation failures avoid backoff storage. Expiry requires a failed lookup, and the neutral-change republish does not directly invalidate itself.
- Worktree deletion uses captured IDs; both rollback arms emit audited outcomes. Parent checks run off async workers.
- Update-state failures retain protection; the other `getUpdateState` callers handle rejection. **A desktop that never answers can leave the marked window blocked indefinitely**, consistent with R35’s fail-closed rule.
- Popup leases release on close/unmount, including kept-mounted popovers. Unchanged rectangles avoid store updates. Markdown workspace loading preserves chat behavior and rejects traversal.
- Pairing refusal logs use fixed classifications. The added-line and commit-message checks found no banned-token or common credential/local-path matches.

**Verification limits**

No files were changed. I ran read-only Git/source checks, `git diff --check`, privacy-pattern scans, and in-memory helper probes. I did **not** run package tests, builds, typechecks, native UI tests, timing benchmarks, or live-provider checks. Popup frame cost and authentication timing therefore remain unmeasured.

Profiler coverage was reviewed: lookup shutdown precedes profiler teardown, and both creation rollbacks retain removal-event coverage. The working tree remained clean.
