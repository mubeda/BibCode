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
region right after the chat opens. This uses no `flushSync` from a ResizeObserver callback, and
it never moves a reader who took over. The eviction case keeps its every-frame assertion. The
round-2 fallback of starting the check after the bottom region's last height change is
dropped.

Three changes.

1. **LegendList patch: apply the preserved end correction in the same pass, once.** In
   `schedulePreservedEndAnchorCorrection` (`react.mjs` about line 2614):
   - Compute `getPreservedEndAnchorOffsetDiff` (about line 2604). When it is larger than the
     epsilon, `requestAdjust` it immediately.
   - Record the immediate request as the correction's `lastRequestTime` before starting the
     existing frame loop. The loop's `hasObservedNativeScrollAfterRequest` check (about line
     2636) then waits for a native scroll after that request before it can adjust again, so the
     offset is not applied twice before the browser's scroll event arrives.
   - A frame loop that finds the diff within the epsilon stops, as today.
2. **LegendList patch: a takeover ends the preserved end target and its correction.** The
   offset check above does not know whether the timeline still follows its end, and
   `cancelScrollRequests()` (about line 7586) leaves both the pending correction and the
   retained initial end target in place, so either could still move a reader who took over
   while a reopened chat settles. `cancelScrollRequests()` therefore also:
   - clears `state.preservedEndAnchorCorrection`, so a queued frame of it returns;
   - releases the retained initial end target with LegendList's own
     `clearPreservedInitialScrollTarget(state)` (about line 935), so nothing re-derives one;
   - cancels the `preservedInitialScroll` scheduled work.

   Every takeover already calls the method, and with nothing under way it changes nothing.
   Patch hash and lockfile update; frozen install verified.
3. **Report the overlay's child-owned height changes before paint.**
   - The Activity card's own height changes (a snapshot arriving, a reconnect, expanding or
     collapsing inside `ActivityPane.tsx` around line 85) do not commit ChatView, so neither a
     ChatView layout effect nor its after-paint ResizeObserver render reaches the list in the
     same frame.
   - The fix: ChatView provides a small overlay-layout context
     (`ComposerOverlayLayoutContext`, in `apps/web/src/components/chat/`) with a report
     function. It measures the overlay element, writes `composerOverlayHeightRef`, and sets the
     overlay height state.
   - `ActivityPaneCard` calls the context's report from its own `useLayoutEffect`, with no
     dependency list, so it runs on each of its commits. A `setState` from a layout effect
     re-renders synchronously before paint, so the list's inset, and LegendList's scroll by its
     growth (with change 1, in the same pass), land before the frame paints.
   - ChatView's ResizeObserver stays as the backstop for changes no React component reports
     (the composer's text wrapping, fonts loading).
   - `ActivityPane.tsx` belongs to #188's owner, so this one-line call is coordinated with them,
     or they add it. No other #188 file changes.

**Tests.**
- **Hooks (`ChatView.hooks.test.tsx`).** The overlay-layout context's report sets the overlay
  height from the measured element in the same pass.
- **ActivityPane test.** The pane calls the report from a layout effect when its expanded state
  or snapshot changes.
- **Packaged, the eviction case unchanged.** Every painted frame of the reopened chat, from the
  first, holds the last line against the usable bottom within 1 px, with the overlay height
  recorded per frame.
- **Packaged, new: a takeover during a reopen.** Reopen the chat, and while LegendList still
  holds its preserved end target, the reader wheels 40 px up in one run and presses PageUp, with
  its page step, in another. The Activity card then grows the bottom region. On every painted
  frame after the takeover, the reader's line stays where their scroll put it.
- **Patch, delayed native scroll.** The double-adjustment guard depends on when the browser
  delivers the scroll event. A packaged probe holds back native scroll handling: a capture
  `scroll` listener on the scroller that records events, while the bottom region grows during
  the preserved window. It asserts the content moves by the growth once, not twice, across
  the frames before and after the delayed event. If a happy-dom mount of the real LegendList
  can model the scroll-event timing, the same check also goes in a unit test; otherwise the
  packaged probe is the proof.

## (b) Diagram swap: a sent turn that starts to fit again

**Goal.** When a sent turn that was taller than the view becomes short enough to fit, because a
diagram replaced its taller source, the sent row returns to its offset (`CHAT_LIST_ANCHOR_OFFSET`,
16 px) while the end stays in view. This is bounded, and never against a reader who took over.

**Change, in ChatView's anchored-turn size handling.**
- `onTimelineRowSizeChanged` today ignores shrinking rows (`info.size <= info.previous`). A
  shrink of a row **in** the anchored turn (`info.index >= anchorIndex`) queues one re-landing
  pass, coalesced like growth (`pendingTurnShrinkRef`) and run two frames later, after
  LegendList has laid the rows out again.
- An earlier row shrinking is LegendList's to hold, so it queues nothing.
- The pass runs only when all of these hold:
  - the mode is still `anchoring-new-turn` and following is on
    (`liveFollowUserScrollGeneration` equals the generation captured when the shrink was
    reported, so a takeover since cancels it);
  - the positioned and settled anchor is the same row;
  - the turn now fits the view (`getActiveTimelineTurnMetrics(...).overflowsUsableViewport` is
    false);
  - the sent row, measured on screen (`measureSentRowLanding`), sits more than 1 px above its
    offset, so the view is past the anchor position: the case following leaves after an
    overflowing turn shrinks.
- The pass then makes one non-animated `scrollToOffset(scrollTop + delta)`, where delta is
  negative: it scrolls up to the row. The turn fits, so its end stays above the bottom region.
- **Bounded re-check.** Like the landing path (`settleSentTimelineRow`), once LegendList
  resolves the request (or 1 s passes), and two frames of layout later, the pass measures again
  under the same guards. It retries only while the row is still more than 1 px off, at most 3
  times or 1 s, so a scroll LegendList clamped to content it had not laid out yet still lands.
- A row below its offset is the landing's case (#191). A turn that still overflows keeps
  following its end. Neither is touched here.

**Tests (hooks, `ChatView.hooks.test.tsx`).**
- A tall reply is followed past the anchor (the scroll is beyond `anchorTop - 16`), then its row
  shrinks so the turn fits: the row comes back to 16.
- The same, with the first correction clamped by a lagging content height
  (`laggingMaxScroll`): the re-check lands it, within its bound.
- After a wheel takeover between the shrink report and the queued pass, nothing scrolls.
- A shrink that leaves the turn still overflowing scrolls nothing (following keeps the end).
- A shrink with the row already within 1 px of its offset scrolls nothing.
- An earlier row, above the anchored turn, shrinking leaves the view in place.
- Growth behavior is unchanged: the existing growth-follow tests stay green.

**Packaged proof.** In the Mermaid reading-line case, frame capture starts **before** the short
reply's diagram draws: the sampler starts when the prompt is sent, and records the sent row's
top, whether the turn fits, the end's position and the overlay height on each painted frame.
It asserts:
- the turn overflowed (at least one frame with `turnFits` false while the source shows), then
  fit after the draw;
- the row returned to 16 ± 1 within a bounded number of frames after it fit;
- a second run of the same sequence, with a real takeover (a wheel event and its scroll) dispatched
  after the shrink's size report and before the queued pass, keeps the row where the reader's
  scroll put it on every later frame.

The CI macOS arm64 geometry (1000×650 window, Activity card above the composer) is where the
overflow happens. Locally, the window is sized to reproduce it.

## Gates before committing either change

- Bisection, starting with one run of the failing recipe (the full Mermaid spec on the build
  expected to fail) to confirm it reproduces, before repeating it:

  | Build | What it decides |
  | --- | --- |
  | Integration head `0ecd10a38c` (no `flushSync`) | Baseline for the eviction first frame and the diagram swap. |
  | Head plus (a1) and (a2) | Whether LegendList's own frame and the retained target are the eviction lag, and that a takeover during a reopen holds. |
  | Head plus (a1), (a2) and (a3) | Whether the eviction lag is gone without `flushSync`. |
  | Head plus (a) and (b) | The diagram swap, with everything together. |
  | Head with #204's round-3 change reverted | Second suspect for the round-2 regressions, if round-3 CI does not clear them. |

- Each build runs the full Mermaid spec, and the `chat-activity-panel.e2e.ts` collapse and
  expand scroll scenario, three times on a dedicated WebDriver port pair. No product change is
  committed without three local passes.
- `vp check --no-fmt`, `vp check` on the changed files, and `vp run typecheck`, plus the hooks,
  `ChatView`, `MessagesTimeline` and Activity suites.
- React review (vercel-react-best-practices) of the context, the ActivityPane layout effect and
  ChatView's handlers. UI.md review of the takeover and bottom-region behavior.
- Docs: `docs/architecture/overview.md`'s Chat timeline following section (about line 3103):
  the same-pass preserved end correction, the takeover clearing it, the overlay-layout report,
  and the fitting turn's return to its offset. The Mermaid runbook paragraph in
  `docs/testing/cross-platform-validation.md` (about line 3446): the swap observation and the
  reopen takeover check.

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

- Reserving the Activity card's space before its content loads: (a3) reports its height before
  paint instead, which covers expand and collapse too.
- Upgrading LegendList (3.7.0) for its end-following rework.
