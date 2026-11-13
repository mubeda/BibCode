# Phase 5: Reasoning row scroll and Host dashboard re-render

- Goal: Expanding or collapsing a reasoning row that the reader brought into view keeps its header within 2 px (R12, diagnosed first, fixed at the first wrong decision), and the Host dashboard values view no longer re-renders on the clock tick alone (R18), each with its tests.
- Round: 1
- Depends on: none
- Owns: `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/ChatView.test.tsx`, `apps/web/src/components/chat/timelineScrollAnchoring.ts` and `apps/web/src/components/chat/timelineScrollAnchoring.test.tsx`, `apps/web/src/components/chat/MessagesTimeline.logic.ts` and `apps/web/src/components/chat/MessagesTimeline.logic.test.ts` (only if the diagnosis lands there), `apps/web/src/components/chat/MessagesTimeline.tsx` (only the `onReasoningRowToggle` call in `ReasoningWorkEntryRow`, only if the diagnosis needs the row id), `apps/web/src/components/hostDashboard/HostDashboardSheet.tsx` and `apps/web/src/components/hostDashboard/HostDashboardSheet.test.tsx`
- Must not touch: `apps/desktop/e2e/**` (Phase 7 owns the harness; the packaged spec is run, never edited), `apps/web/src/components/ThreadTerminalPanel.tsx`, `apps/web/src/components/ChatMarkdown.tsx`, `apps/web/src/components/hostDashboard/hostDashboard.logic.ts`
- Skills: `vercel-react-best-practices` (required review for every React change under apps/web); `tdd` (red-green cycle for each behavior change); `mstack-diagnose` (Task 5.1 is a diagnosis, not a fix)
- Read first: `AGENTS.md` (completion rules, profiler coverage line, sensitive data); `UI.md` (the toggle must not move the reader's place); `docs/architecture/overview.md` section on the web client (state owner of timeline scroll); `docs/plans/2026-11-13-issue-batch-348-358/spec.md` (R12, R18 and D14 are binding); `apps/desktop/e2e/specs/chat-reasoning-rows.e2e.ts` (the packaged invariant: `expandThoughtAwayFromEnd` and `expandStreamingThoughtAtEnd`)
- Checkpoint: from `apps/web`, `vp test run --project unit src/components/ChatView.test.tsx src/components/chat/timelineScrollAnchoring.test.tsx src/components/chat/MessagesTimeline.logic.test.ts src/components/hostDashboard/HostDashboardSheet.test.tsx` exits 0, then `vp check <changed files>` and `vp run typecheck` exit 0. Later proof, owned by Phase 8 (Tasks 8.1 and 8.3) and not by this phase: the packaged `chat-reasoning-rows` spec in the Linux lab at a 1000x720 viewport (a failure there reproduces the bug without WebView2; it does not by itself name the cause), and in the Windows VM at the viewport where it failed.

## Background (read before Task 5.1)

Three code paths can scroll the list to its end after a reasoning row toggles. All are in `ChatView.tsx` unless noted.

- H1, the toggle's end reveal: `onReasoningRowToggle`. It runs when `rowToggleNeedsEndReveal({ mode, scrollDeltaToRevealEnd })` is true (mode `anchoring-new-turn` and `scrollDeltaToRevealEnd <= 1` before the toggle) and `liveFollowUserScrollGenerationRef.current === anchorUserScrollGenerationRef.current`. Two animation frames later it calls `list.scrollToOffset({ offset: scroll + scrollDeltaToRevealEnd, animated: false })`. Two frames is 16 to 50 ms, the window the issue measured.
- H2, the grown-turn follow: `onTimelineRowSizeChanged` then `followGrownTurn`. In mode `anchoring-new-turn` a row that grows starts a two-frame wait, then `followTimelineLiveEnd` runs when `scrollDeltaToRevealEnd - (growth - held) <= 1`, which is the same "the end was in view before" condition.
- H3, the list's end maintenance: `MessagesTimeline` passes `maintainScrollAtEnd={resolveTimelineMaintainScrollAtEnd({ anchored, followsEnd })}`; with `followsEnd` true the config has `on.itemLayout: true`, so LegendList scrolls to its end by itself when it judges the list at its end.

What makes all three possible: the packaged spec scrolls with `scrollIntoView({ block: "center" })`, which is not a reader gesture. `onIsAtEndChange(false)` returns early when `liveFollowUserScrollGenerationRef.current === anchorUserScrollGenerationRef.current`, so after that scroll the mode stays `anchoring-new-turn` and `timelineFollowsEnd` stays true.

Paths in this plan: the repository keeps `timelineScrollAnchoring.ts` and `MessagesTimeline.logic.ts` under `apps/web/src/components/chat/`, not directly under `components/`.

## Tasks

### Task 5.1: Diagnose which path scrolls to the end after a programmatic scroll and a toggle

- Satisfies: R12 (diagnose-first step 2). Scenario pinned: Given the reader scrolled a reasoning row to the center without a wheel or touch gesture, When the row is toggled, Then no scroll to the end is made within three animation frames.
- Depends on: none
- Files: modify `apps/web/src/components/ChatView.test.tsx`
- Interfaces: consumes `ChatView` props captured by `capturedProps<Record<string, unknown>>("messagesTimeline")` with the keys `onReasoningRowToggle: () => void`, `onRowSizeChanged: (info: { index: number; previous: number; size: number }) => void`, `onIsAtEndChange: (isAtEnd: boolean) => void`, `onAnchorReady: (id: MessageId, index: number) => void` and `followsEnd: boolean`; consumes the `h.timelineList` mock with `getState`, `getScrollableNode`, `scrollToOffset`, `scrollToIndex`, `scrollToEnd` as in the test "a pointer press on $pressed before a toggle at an anchored turn's end". Produces a `describe("R12 scroll path after a programmatic scroll")` with three tests, one per hypothesis, each exercising its path alone, and a verdict comment naming the confirmed path or paths. Task 5.2 relies on the verdict and on the shared helper `anchoredTurnAfterProgrammaticScroll()` that this task adds in the test file.
- Skills: mstack-diagnose (decide by test; no fix before the verdict)
- Read first: `apps/web/src/components/ChatView.test.tsx` test "a pointer press on $pressed before a toggle at an anchored turn's end" (the harness to copy); `apps/web/src/components/ChatView.tsx` `onIsAtEndChange`, `onReasoningRowToggle`, `followGrownTurn`, `onTimelineRowSizeChanged`; `apps/web/src/components/chat/timelineScrollAnchoring.ts` `rowToggleNeedsEndReveal`
- Tier: most capable
- TDD: red-green
- Done when: from `apps/web`, `vp test run --project unit src/components/ChatView.test.tsx -t "R12 scroll path"` exits 0 and the verdict comment above the `describe` names which of H1, H2, H3 issued a scroll.

Steps

1. [ ] Read the baseline lab result from the plan log (the coordinator runs the packaged `chat-reasoning-rows` spec in the Linux lab on the base commit before round 1, plan decision P3). Use it only to choose which metrics to reproduce: whether `expandThoughtAwayFromEnd` failed there, the header movement it reported, and the viewport and `scrollTop` it recorded. A failure at 1000x720 is a platform-independent reproduction, not proof of the cause. A pass there means the unit metrics below must stay the issue's WebView2 numbers, and is no evidence for or against any hypothesis. If the log has no baseline result yet, continue with the issue's numbers and say so in the verdict comment.
2. [ ] Add the helper `anchoredTurnAfterProgrammaticScroll()` to the test file. It copies the setup of the existing #173 test (seed the thread, render `ChatView`, send, call `onAnchorReady`) with the spec's metrics: `scroll: 0`, `scrollLength: 720`, an anchor row at index 0, the turn's last row ending inside the viewport so `scrollDeltaToRevealEnd` is at most 1 before the toggle, and no `pointerdown` on the list or the toggle. It then calls `onIsAtEndChange(false)` to stand for the programmatic scroll. It returns the timeline props, the `scrollToOffset`, `scrollToIndex` and `scrollToEnd` mocks, and a `growRow(height: number)` function that raises the last row's height by 1014 px, the distance the issue measured.
3. [ ] Write test `H1: the toggle's end reveal makes no scroll after a programmatic scroll` as `it.fails`. Prediction if H1 is the culprit: calling `onReasoningRowToggle()`, then `growRow(1014)`, then advancing three animation frames gives exactly one `scrollToOffset` call with an offset at or above the old end, so the assertion `scrollToOffset` not called fails, which `it.fails` accepts.
4. [ ] Write test `H2: the grown-turn follow makes no scroll after a programmatic scroll` as `it.fails`. It never calls `onReasoningRowToggle`. It calls `onRowSizeChanged({ index, previous, size: previous + 1014 })` after `growRow(1014)` and advances three frames. Prediction if H2 is the culprit: one `scrollToOffset`, `scrollToIndex` or `scrollToEnd` call.
5. [ ] Write test `H3: the list's end maintenance stays off after a programmatic scroll and a toggle` as `it.fails`. It calls `onReasoningRowToggle()` and reads `followsEnd` from the re-captured `messagesTimeline` props. Prediction if H3 is the culprit: `followsEnd` is still `true`, so LegendList's `maintainScrollAtEnd` stays on while the reader's row is away from the end. Assert `followsEnd` is `false`.
6. [ ] Run `vp test run --project unit src/components/ChatView.test.tsx -t "R12 scroll path"` from `apps/web`. Run it once with each `it.fails` temporarily changed to `it`. Expected: FAIL for the tests of the confirmed hypotheses, that is, they FAIL with the assertion messages above, and the others PASS. A test that passes as `it` is a path that does not scroll; keep it as a plain `it`.
7. [ ] Write the verdict comment above the `describe`: which of H1, H2, H3 failed, and the first wrong decision for each: H1 is the reveal decision in `onReasoningRowToggle` (it cannot tell the toggled row from the newest row), H2 is the follow decision in `followGrownTurn` (same blind spot), H3 is `timelineFollowsEnd` staying true after a programmatic scroll away from the end. If none fails (no path scrolls with these metrics), say so, keep the three tests as plain `it`, and stop: report to the coordinator that the unit metrics do not reproduce the packaged failure, so Phase 8's Linux-lab run at 1000x720 (Task 8.1) is the next step and Task 5.2 makes no code change.
8. [ ] Restore the `it.fails` marks on the confirmed paths and run the command of step 6. Expected: PASS.
9. [ ] Run `vp check src/components/ChatView.test.tsx` from `apps/web`. Expected: no errors.

### Task 5.2: Fix the first wrong decision the diagnosis names

- Satisfies: R12. Scenarios pinned: Given a programmatic scroll to a reasoning row and a toggle, Then no scroll to the end is made within three animation frames; Given the newest reasoning row at the end of an anchored turn, Then the #173 reveal still happens.
- Depends on: 5.1
- Files: modify `apps/web/src/components/ChatView.tsx`; modify `apps/web/src/components/chat/timelineScrollAnchoring.ts` and `apps/web/src/components/chat/timelineScrollAnchoring.test.tsx` (H1 or H2); modify `apps/web/src/components/chat/MessagesTimeline.logic.ts` and `apps/web/src/components/chat/MessagesTimeline.logic.test.ts` (H3 only); modify `apps/web/src/components/chat/MessagesTimeline.tsx` (H1 only); test `apps/web/src/components/ChatView.test.tsx`
- Interfaces: consumes the verdict comment and `anchoredTurnAfterProgrammaticScroll()` from Task 5.1. Produces, per confirmed hypothesis, exactly one of: (H1) `rowToggleNeedsEndReveal(input: { mode: TimelineScrollMode; scrollDeltaToRevealEnd: number | null; toggledRowIsNewest: boolean }): boolean` returning false when `toggledRowIsNewest` is false, with `onReasoningRowToggle(rowId: string): void` in `ChatView.tsx` and `MessagesTimeline.tsx` passing `reasoning.id`, and `toggledRowIsNewest` computed from `list.getState().data` as "no reasoning or work row follows the toggled row before the working row"; (H2) the same predicate applied in `onTimelineRowSizeChanged`, through a `reasoningToggleRowIdRef` set by `onReasoningRowToggle` for one frame pair so a size change caused by a non-newest toggle does not start `followGrownTurn`; (H3) when `onReasoningRowToggle` decides not to reveal, it calls `setTimelineFollowsEnd(false)`, and `onIsAtEndChange(true)` restores it, so `resolveTimelineMaintainScrollAtEnd({ anchored, followsEnd: false })` returns `false`. If several hypotheses were confirmed, apply the fix of each in the order H1, H2, H3, one test each.
- Skills: tdd (red-green for the changed decision); vercel-react-best-practices (review of changed callbacks and refs)
- Read first: the verdict comment from Task 5.1; `apps/web/src/components/chat/MessagesTimeline.tsx` `ReasoningWorkEntryRow` (where `onReasoningRowToggle()` is called); `apps/web/src/components/ChatView.test.tsx` test "a pointer press on $pressed before a toggle at an anchored turn's end" (must still pass unchanged)
- Tier: standard
- TDD: red-green
- Done when: from `apps/web`, `vp test run --project unit src/components/ChatView.test.tsx src/components/chat/timelineScrollAnchoring.test.tsx src/components/chat/MessagesTimeline.logic.test.ts` exits 0, including the unchanged #173 test.

Steps

1. [ ] Flip the confirmed tests of Task 5.1 from `it.fails` to `it`. They are the failing tests of this task.
2. [ ] Add a second test beside them, `the newest reasoning row at the end of an anchored turn still reveals the end after a toggle`, built on the #173 test's setup (a toggle of the newest row with a pointer press on its button). Assert exactly one `scrollToOffset` call with an offset above 2000, as the #173 test does.
3. [ ] Run `vp test run --project unit src/components/ChatView.test.tsx -t "R12 scroll path"` from `apps/web`. Expected: FAIL on the flipped tests with the assertion messages from Task 5.1 step 6; the new reveal test PASSES.
4. [ ] Implement the fix named for the confirmed hypothesis in Interfaces, at the first wrong decision only. For H1 add the `toggledRowIsNewest` cases to `timelineScrollAnchoring.test.tsx` next to the existing `rowToggleNeedsEndReveal` cases: `mode: "anchoring-new-turn"`, `scrollDeltaToRevealEnd: 0`, `toggledRowIsNewest: false` gives false; `true` gives true.
5. [ ] Run the Done-when command. Expected: PASS, including "a pointer press on a Thinking row's toggle before a toggle at an anchored turn's end" for both rows of its table.
6. [ ] Prove the test can fail: revert the fix temporarily (make the new predicate or guard always true), run the Done-when command. Expected: FAIL on the flipped R12 test. Restore the fix and run it again. Expected: PASS.
7. [ ] Review the changed callbacks and refs against `vercel-react-best-practices` (stable callbacks, no state in a render path, no effect added). Run `vp check` on the changed files and `vp run typecheck`. Expected: no errors.
8. [ ] State the profiler coverage line for the final report: none of child processes, RPC methods, worktree removal, binaries, shutdown, events or findings is touched.

### Task 5.3: Stop the Host dashboard values view re-rendering on the clock tick

- Satisfies: R18. Scenario pinned: Given an open dashboard whose reading has not changed, When the 1 s tick fires three times, Then the values view and its charts do not render again.
- Depends on: none
- Files: modify `apps/web/src/components/hostDashboard/HostDashboardSheet.tsx`; test `apps/web/src/components/hostDashboard/HostDashboardSheet.test.tsx`
- Interfaces: consumes `HostDashboardValuesView({ values: HostDashboardValues; view: HostMetricsView | null; timestampFormat })` and `HostMetricBars`. `presentHostDashboard` builds a fresh `values` object and fresh `volumes`, `hiddenVolumes` and `statistics` arrays each render, so a reference check cannot work. Produces `const HostDashboardValuesView = memo(Inner, valuesViewPropsEqual)` where `valuesViewPropsEqual(previous, next): boolean` is true when `view` and `timestampFormat` are identical by reference and `values` is structurally equal (the same strings and rows). Search `apps/web/src` for an existing deep-equal helper first and use it; if none exists, write a local structural comparison in the sheet file. The `since` text carries the uptime, so it changes on its own schedule and correctly lets the view render then.
- Skills: tdd (red-green for the render count); vercel-react-best-practices (memo comparator review)
- Read first: `apps/web/src/components/hostDashboard/HostDashboardSheet.tsx` `useVisibleSecondTick` and `HostDashboardValuesView`; `apps/web/src/components/hostDashboard/HostDashboardSheet.test.tsx` test "dims the values after 3 seconds without an item" (fake timer setup to copy); `apps/web/src/components/hostDashboard/HostMetricBars.tsx` (the child whose renders are counted)
- Tier: standard
- TDD: red-green
- Done when: from `apps/web`, `vp test run --project unit src/components/hostDashboard/HostDashboardSheet.test.tsx` exits 0.

Steps

1. [ ] Write the failing test `does not render the values view again when only the clock tick changed` in `HostDashboardSheet.test.tsx`. Use the fake timers of the "dims the values" test. Mock `./HostMetricBars` with a wrapper around the real component that increments a counter on each render. Render with `h.data = view()`, record the count, then `await act(async () => vi.advanceTimersByTime(3_000))` with the same data. Assert the counter is unchanged. Also assert the text `Last updated 3 s ago` still shows, so the sheet itself did re-render and only the values view was skipped.
2. [ ] Run `vp test run --project unit src/components/hostDashboard/HostDashboardSheet.test.tsx -t "clock tick"` from `apps/web`. Expected: FAIL with the counter higher than the recorded value.
3. [ ] Implement `valuesViewPropsEqual` and wrap `HostDashboardValuesView` in `memo` with it, in `HostDashboardSheet.tsx`.
4. [ ] Add a second assertion test `renders the values view again when a reading changes`: replace `h.data` with a view whose CPU differs and assert the counter rises and the new percent shows. Run the Done-when command. Expected: PASS.
5. [ ] Prove the test can fail: make `valuesViewPropsEqual` return false, run the Done-when command. Expected: FAIL on the clock tick test. Restore it and run again. Expected: PASS.
6. [ ] Review against `vercel-react-best-practices` (comparator cost is small next to a render; no inline object props added). Run `vp check apps/web/src/components/hostDashboard/HostDashboardSheet.tsx apps/web/src/components/hostDashboard/HostDashboardSheet.test.tsx` and `vp run typecheck`. Expected: no errors.
7. [ ] Log in the final report that no user-visible string, state or layout changed, so the `UI.md` review has nothing new to review.
