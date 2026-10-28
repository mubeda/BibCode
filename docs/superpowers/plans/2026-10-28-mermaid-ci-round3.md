# Mermaid timeline CI, round 3: plan

Branch `claude/b3f-mermaid-ci2`, rebased onto `0ecd10a38c` (integration with `21958e280a`'s
`flushSync` reverted). Implementation waits until either the disk has at least 40 GB free, so
the Mermaid spec can run packaged three times per build locally, or the round-3 CI result
(run 40668980338) is in. This document is the design only.

## Source facts this plan rests on

These are from `@legendapp/list` 3.3.10 (`apps/web/node_modules/@legendapp/list/react.mjs`) and
the round-2 traces.

- **Bottom inset changes.** LegendList applies a change to `contentInsetEndAdjustment` in a
  layout effect (`updateContentInsetEndAdjustment`, about line 8300). When the inset grows and
  the list is within its end threshold, it scrolls by the growth with `requestAdjust`, unless
  `retargetActiveInitialScrollAtEnd` returns true.
- **After the initial scroll to the end.** Once the reopened list's initial scroll to the end
  has finished, that retarget calls `schedulePreservedEndAnchorCorrection`. This applies the
  correction in a `requestAnimationFrame`, one frame later, and skips the immediate
  `requestAdjust` (about lines 2614-2643 and 3130-3141). So for an inset change shortly after a
  chat opens, LegendList itself adds a frame of lag.
- **ChatView's overlay measurement.** ChatView measures the composer overlay, which now holds
  the Activity card (#188), with a ResizeObserver whose `setState` React renders after the
  frame paints. That is a second frame of lag, between the overlay growing and the new inset
  reaching LegendList.
- **Eviction trace, Windows arm64, round 2.** In the first painted frame of the reopened chat,
  the overlay top was already final (486 px), the end gap was 0, and the last line was 44 px
  low. The next frame was at rest. So the inset reached the list's spacer, and its scroll, one
  frame after the overlay grew.
- **Eviction trace, macOS x64, round 2.** The first frame had an end gap of 58 px; the next
  frame was at rest. This is the same one-frame lag, landing before the list caught up with the
  end.
- **Diagram-swap sent-row trace, macOS arm64, round 2.** For 36 frames the row sat 29 px above
  its offset (top −13). The turn fit, its end was 48 px above the usable bottom, and the overlay
  was 210 px.
  - Most likely, the turn overflowed while the diagram showed its source, so following
    revealed its end (as designed).
  - When the diagram drew and the turn shrank to fit, nothing brought the row back.
  - LegendList did not clamp the scroll back either. When the inset is larger than the anchored
    end space, its spacer (`max(0, inset - endSpace)`) leaves scroll room past the anchor
    position, and the 210 px overlay with the Activity card is that case.

## (a) Eviction: the first painted frame after reopening

**Goal.** From the first painted frame of a reopened chat, the reply's last line sits at its
end against the bottom region, including when the Activity card arrives and grows the bottom
region right after the chat opens. This uses no `flushSync` from a ResizeObserver callback.

Two changes, either of which shortens the lag. Both are needed to remove it.

1. **LegendList patch: apply the preserved end correction in the same pass.** In
   `schedulePreservedEndAnchorCorrection`, apply the correction once synchronously: compute
   `getPreservedEndAnchorOffsetDiff`, and when it is larger than the epsilon, `requestAdjust`
   it. Then schedule the existing frame loop for any later drift. That removes LegendList's own
   frame: the inset's layout effect then moves the end in the same commit.
   - This only ever moves a list LegendList is keeping at its end.
   - A reader who took over has the list's end keeping finished (`cancelScrollRequests`), and,
     while away, a held inset that does not grow (`MessagesTimeline`). The correction never
     runs over them.
   - Patch hash and lockfile update; frozen install verified.
2. **ChatView: get the overlay's new height to the list in the same commit, without
   `flushSync`.** Measure the overlay in a layout effect that runs whenever ChatView commits
   something that changes the overlay's content: the Activity card's presence and size inputs
   it renders (`activityStateTarget`, `shouldUseCompactActivityDock`,
   `settings.activityDockAlwaysVisible`, the pending-input and queue banners). A `setState`
   from a layout effect re-renders synchronously before paint, which React supports. That runs
   at commit time, not inside the browser's ResizeObserver delivery, where `flushSync`
   (round 2) is suspected of re-entering LegendList's layout effects before LegendList had
   processed its own row sizes.
   - The ResizeObserver stays for growth that ChatView does not render itself: the Activity
     card's own content loading, and the composer's text wrapping.
   - That path keeps its one frame of lag. Changes to the card's content are #188's (the
     Activity card owner's) code, so if it matters there, the card can report its layout to
     ChatView through a callback from its own layout effect. I won't change #188's files.
3. **Test side, only if (2) cannot cover the card's arrival.** If the card's first height comes
   from its own content loading, so only the ResizeObserver sees it, the intended UI includes
   one frame where the card has arrived and the list has not yet moved. The eviction case then
   starts its every-frame check from the first painted frame after the bottom region's height
   last changed. The trace records the overlay height per frame, and the check records which
   frame it starts from and why. That keeps the case strict on what it is for (the evicted
   diagram's redraw never steps the end) without requiring a frame the UI does not produce.

**Bisection, before (a) is implemented.**

| Build | What it decides |
| --- | --- |
| Integration head `0ecd10a38c` (no `flushSync`) | Baseline for the eviction first frame and the round-2 regressions. |
| Head plus (a1) | Whether LegendList's own frame is the eviction lag. |
| Head plus (a1) and (a2) | Whether the lag is gone without `flushSync`. |
| Head with #204's round-3 change reverted | Second suspect for the round-2 regressions, if round-3 CI does not clear them. |

Each build runs the full Mermaid spec three times on a dedicated WebDriver port pair. No
product change is committed without three local passes.

## (b) Diagram swap: a sent turn that starts to fit again

**Goal.** When a sent turn that was taller than the view becomes short enough to fit, because a
diagram replaced its taller source, the sent row returns to its offset (`CHAT_LIST_ANCHOR_OFFSET`,
16 px) while the end stays in view. This is bounded, and never against a reader who took over.

**Change, in ChatView's anchored-turn growth handling.**
- `onTimelineRowSizeChanged` today ignores shrinking rows (`info.size <= info.previous`). A
  shrink of a row in or above the anchored turn queues one re-landing pass, coalesced like
  growth (`pendingTurnShrinkRef`) and run two frames later, after LegendList has laid the rows
  out again.
- The pass runs only when all of these hold:
  - the mode is still `anchoring-new-turn`, following is on (`liveFollowUserScrollGeneration`
    equals the current generation, so a takeover since cancels it), and the positioned and
    settled anchor is the same row;
  - the turn now fits the view (`getActiveTimelineTurnMetrics(...).overflowsUsableViewport` is
    false);
  - the sent row, measured on screen (`measureSentRowLanding`), sits more than 1 px above its
    offset, so the view is past the anchor position: the case following leaves after an
    overflowing turn shrinks.
- The pass then makes one non-animated `scrollToOffset(scrollTop + delta)`, where delta is
  negative: it scrolls up to the row. The turn fits, so its end stays above the bottom region.
- A row below its offset is the landing's case (#191). A turn that still overflows keeps
  following its end. Neither is touched here.
- No retry loop. If LegendList clamps the scroll, the next shrink or growth report runs the
  pass again, and the follow pass handles growth.

**Tests (hooks, `ChatView.hooks.test.tsx`).**
- A tall reply is followed past the anchor (the scroll is beyond `anchorTop - 16`), then its row
  shrinks so the turn fits: one `scrollToOffset` puts the row at 16.
- After a wheel takeover, the same shrink scrolls nothing.
- A shrink that leaves the turn still overflowing scrolls nothing (following keeps the end).
- A shrink with the row already within 1 px of its offset scrolls nothing.
- Growth behavior is unchanged: the existing growth-follow tests stay green.

**Packaged proof.** The Mermaid reading-line case's sent-row check (`mermaid-timeline-sent-row.json`
frames). On the CI macOS arm64 geometry (1000×650 window, Activity card above the composer),
the row must come back to 16 ± 1 once the short reply's diagram draws. Locally, the same check
3× per build.

## Round-2 regressions after the revert

Keyboard handoff and reader-above-end (macOS) and Thinking rows (Linux x64) passed in round 1
and failed in round 2, with only `21958e280a` and #204's overlay ref between. They are
expected back with the revert. If round 3 still fails any of them, the next suspects are:

1. #204's overlay ref (bisection row above).
2. For Thinking rows, `eda06a872d`'s above-anchor growth follow, which would also follow a
   thought expanded on screen above the anchored turn. The refinement would follow growth of
   rows above the anchor only when the row lies wholly above the visible top: growth LegendList
   should have held, not a row the reader is looking at. The hooks test is an on-screen row
   above the anchor growing while the end shows, which must not move the view.

## Skipped

- Changing #188's Activity card to reserve its space before its content loads. That is its
  owner's call; (a3) covers the test if needed.
- Upgrading LegendList (3.7.0) for its end-following rework.
