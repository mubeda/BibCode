# Timeline follow batch: #193, #190, #191

Branch `claude/b3-timeline-follow` from `origin/develop` at 27702287cc. Order:
#193 first, so the Mermaid spec is strict before it validates #190 and #191.

Owned files: the follow, scroll, sent-row and glide code in
`apps/web/src/components/ChatView.tsx` (about lines 3984 to 4455),
`apps/web/src/components/chat/timelineScrollAnchoring.ts` and its test, the
follow tests in `apps/web/src/components/ChatView.hooks.test.tsx`,
`apps/desktop/e2e/specs/mermaid-diagrams.e2e.ts`, and the matching lines in
`docs/testing/cross-platform-validation.md` and `docs/user/workspace-ui.md`.
I won't touch the ActivityDockBinding region or the activity panel layout.

No living architecture document covers live following. `docs/architecture/overview.md`
covers only the reading anchor (about lines 3038 to 3055), and that does not change.

## #193: the streamed-follow check is only as strict as its plain baseline

**Acceptance criterion.** In "follows the end while a streamed reply's diagram
draws", the plain reply's own rests are bounded. From the moment the plain
reply's sent row has settled, every delivery after its code block shows must
come to rest with the reply's end revealed (`endBelow <= 1`). If either reply
stays hidden through the stream and only catches up at the end, the spec fails.

**Root cause.** `mermaid-diagrams.e2e.ts:1020-1022`: `revealedBelow(d)` is
`max(plainRests.get(d) ?? 0, 0) + 1`. Nothing asserts on `plainRests` itself, so
a plain reply resting 300 px hidden at each delivery lets the diagram reply rest
301 px hidden.

**Change (spec only).**
- Find the plain reply's settle point the same way as the diagram reply's
  `checkedFrom` (lines 1023-1032). It is the earlier of two moments: the first
  plain sample with its code block shown and its end revealed, or the first
  streamed delivery plus `SENT_ROW_SETTLE_MS`. Share one small helper rather
  than copy the expression.
- For every plain delivery that rests (the last painted sample for that delivery
  key, as `restingEnds` and `restingSamples` build it) at or after that point,
  collect `{ delivered, at, endBelow, checkedFrom }` where `endBelow > 1`, then
  `expect(plainEndsHidden).toEqual([])`. The CI diff then names each delivery
  that failed, with its gap and timing.
- Also require that the plain reply caught up at all (`plainCaughtUp` defined).
  The failure message gives the reply's last rest.
- Change `endsHidden` to labelled objects in the same shape, so both failures
  read the same way. The diagram bound itself does not change. With the plain
  rests bounded, `revealedBelow` is at most 2 wherever it is checked.
- Record each delivery's painted-frame count until the end is revealed in the
  `mermaid-timeline-streaming-follow.json` trace. This is diagnostic only, not
  asserted. The follow takes a React commit plus two animation frames, and
  LegendList can clamp it and recheck for up to six double frames, so a bound
  of "one frame" would be flaky on CI runners. The resting bound is the one
  the issue asks for.
- Update the spec's comment block (lines 1008-1019).

**Proof.** The spec passes on this Mac (packaged, macOS arm64) with the bound in
place. If local plain rests sit at a consistent positive value, I will report it
as a product finding rather than widen the bound. To show the new assertion can
fail, I will run a throwaway local check: a temporary edit that skips
`followTimelineLiveEnd` makes `plainEndsHidden` non-empty. That edit is never
committed. Windows and Linux evidence comes from CI.

**Runbook.** `cross-platform-validation.md` lines 3165-3171: "rests no lower
below the composer than the plain reply's" becomes "once each reply's sent row
has settled, every delivery after its code block shows rests with the reply's
end revealed, and the diagram reply rests no lower than the plain one".

## #190: arrow keys do not stop live following

**Acceptance criterion.** With focus inside the timeline's scroller (not in the
composer), the keys ArrowUp, ArrowDown, PageUp, PageDown, Home, End and Space
(including Shift+Space) stop live following and the anchored turn's growth
follow, in the same way as wheel, touchmove and pointerdown. This includes the
case during a sent row's glide: the follow that runs when the glide settles no
longer takes the reader back to the turn's end. A key that would move nothing
does not stop following. A key that a row's own control owns does not stop it
either.

**Root cause.** `ChatView.tsx:4113-4135` binds only `wheel`, `touchmove` and
`pointerdown` (filtered by `pointerPressStopsLiveFollow`) on the scroll node.
`pageTimeline` (lines 4079-4100) already cancels for PageUp and PageDown pressed
in the composer (`ChatComposer.tsx:1926`). Keys pressed while focus is inside
the scroller, for example on a row's button after a click, which by #173 keeps
following on, scroll the list natively and never call
`cancelTimelineLiveFollowForUserNavigation`.

**Change.**
- `timelineScrollAnchoring.ts`: add a pure
  `keyboardScrollStopsLiveFollow(event, scroller)` beside
  `pointerPressStopsLiveFollow`. It returns true only when all of these hold:
  - the key is one of the seven;
  - the event is not `defaultPrevented` (a row's control, or the window's
    capture-phase shortcut handler, owned it);
  - the target is not editable (`input`, `textarea`, `select`,
    `isContentEditable`);
  - Space is not pressed on a control (`TIMELINE_CONTROL_SELECTOR`), where it
    activates the control;
  - the key can still move the list. A down key (ArrowDown, PageDown, End,
    Space) at `scrollTop >= scrollHeight - clientHeight - 1`, or an up key
    (ArrowUp, PageUp, Home, Shift+Space) at `scrollTop <= 1`, does not count.
    This mirrors `pageTimeline`'s guard (lines 4091-4094). The guard matters:
    after a cancel, `onIsAtEndChange` (line 4250) returns early while
    `isAtEndRef` is still true, so cancelling on an ArrowDown at the end would
    leave following off until the reader scrolls away and back.
- `ChatView.tsx`: add a passive `keydown` listener on the same scroll node in
  the same effect. It calls the same cancel through
  `cancelTimelineLiveFollowForUserNavigationRef`, and the effect's cleanup
  removes it.
- `ChatView.hooks.test.tsx`: change the comment at line 1948 ("moved up 80 px
  with the keyboard, which keeps following on") to "a scroll the timeline does
  not see as the reader's own". The test's behavior is unchanged.

**Tests (complete caller first).**
- `ChatView.hooks.test.tsx`. Extend the fake scroll node so `fire(type, event?)`
  passes an event and the node exposes `scrollHeight` and `clientHeight`, then
  add these cases:
  - add `"keydown"` to the listener assertion at lines 1719-1721;
  - `sendTallReply`, ArrowUp from inside the scroller before `scrollend`: the
    settle neither pins nor follows to 216, which fails before the fix;
  - ArrowDown at the end: following continues, and the next follow still runs;
  - keydown on a textarea inside the scroller: following continues;
  - Space on a button: following continues.
- `timelineScrollAnchoring.test.tsx`: a table of the helper's cases (each key,
  each modifier case for Space, `defaultPrevented`, editable targets, the
  top-end and bottom-end guards).
- No keyboard e2e. A synthetic `keydown` does not scroll natively, so it would
  prove only what the hooks test proves. `restAnchorBelowTop` keeps its wheel
  dispatch.

**Docs.** In `docs/user/workspace-ui.md`, after the PageUp/PageDown paragraph
(about lines 511-518), add one sentence: scrolling the timeline yourself (with
the wheel, a touch, the scrollbar, or the keyboard while the timeline has focus)
stops it following a streaming reply, and returning to the end resumes it.

## #191: the sent row can settle a few pixels short of its offset

**Acceptance criterion.** After a send whose reply fits in the view, once the
glide settles, on `scrollend` or the 750 ms timer, the sent row's top sits
within 1 px of `CHAT_LIST_ANCHOR_OFFSET` (16 px) below the scroller's top,
measured in the DOM. That is what the spec's sent-row check reads
(`mermaid-diagrams.e2e.ts:641-643`). Settling happens as soon as it does today,
and macOS WebKit following does not regress.

**Root cause.** `ChatView.tsx:4178-4179`. `finishAnimatedPositioning` pins
`list.getState().scroll`. When the 750 ms timer fires, a slow webview's glide
is still moving, and LegendList's state lags a smooth scroll by up to a frame,
so the pin stops the row 11-16 px short (Windows x64 and Linux x64 packaged
smoke).

**Change.** In `finishAnimatedPositioning`:
- Find the sent row with
  `scrollNode.querySelector('[data-message-id="<CSS.escape(messageId)>"]')`.
  `MessagesTimeline.tsx:1194` renders this attribute, and the spec measures the
  same element.
- Compute `delta = rowTop - scrollNode.getBoundingClientRect().top - CHAT_LIST_ANCHOR_OFFSET`.
  The geometry goes in a pure `getSentRowLandingDelta` helper in
  `timelineScrollAnchoring.ts`.
- If `|delta| > 1`, call
  `scrollToOffset({ offset: scrollNode.scrollTop + delta, animated: false })`.
  Read `scrollTop` from the DOM, not `getState().scroll`. Otherwise pin as
  today. Make one correction, with no loop and no waiting.
- If the row is not in the DOM, fall back to today's pin.
- Then set `settledTimelineAnchorRef` and run the follow pass after two frames,
  exactly as today.

**Why this avoids the reverted landing** (18546f200c, reverted in f78938e33c).
That change landed with a non-animated `scrollToIndex` and held settling for up
to 1 s waiting for it. LegendList can defer that landing while rows measure,
and it uses LegendList's position model, which was 11 px off on Windows. A
non-animated `scrollToOffset` goes straight to `doScrollTo` (`react.mjs`
1327-1363: `scroller.scrollTo` now, finish on a 100 ms timeout), and the target
comes from the DOM. Settling and the follow pass keep today's timing. When the
glide has finished, `delta` is about 0, so the behavior is today's exactly.
`onTimelineAnchorSizeChanged` (lines 4199-4239) records its restore offset
after settling, so it holds the corrected offset.

**Known risk, handled only if evidence shows it.** During an animated scroll,
LegendList defers MVCP adjustments (`ScrollAdjustHandler.pendingAdjust`) and
commits them in `finishScrollTo`, 100 ms after our scroll. If rows above the
sent row resized during the glide, that commit could move the row again. If
the macOS trace or CI shows a residual offset after the landing, the follow-up
is one recheck after the `scrollToOffset` promise resolves: same anchor, same
generation, and the turn does not overflow the view. That recheck is not in
the initial change.

**Tests.**
- `timelineScrollAnchoring.test.tsx`: the delta helper, covering row low, row
  high, within 1 px (null), and no row (null).
- `ChatView.hooks.test.tsx`. Give the fake scroll node `querySelector` (an
  optional fake row) and `getBoundingClientRect`, then add these cases:
  - `scrollend` with the row 12 px low gives `{ offset: scrollTop + 12, animated: false }`
    before the follow, which fails before the fix;
  - the 750 ms timer path with fake timers and no `scrollend` gives the same;
  - a missing row keeps `{ offset: 0, animated: false }`, so the tests at lines
    1844-1912 stay unchanged.
- Spec (complete caller): the sent-row check at lines 641-643 asserts on a
  labelled object (`{ top, expected: 16, off }`), so a CI failure reads, and
  the trace records the row offset. On this Mac it proves there is no
  regression, including the streamed-follow test that the reverted landing
  failed 2 out of 2 times. This Mac cannot reproduce the short landing.
  Windows and Linux evidence comes from CI.

**Runbook.** The sentence at lines 3149-3150 ("leaves that message at the
sent-row offset") gains "within 1 px, measured from the scroller's top". There
is no other change.

## Validation (phase 2)

- Run `vp test run --project unit` from `apps/web` for
  `src/components/chat/timelineScrollAnchoring.test.tsx`,
  `src/components/ChatView.hooks.test.tsx`, `src/components/ChatView.test.tsx`
  and `src/components/chat/ChatComposer.test.tsx`.
- Run `vp check --no-fmt`, `vp check <changed files>`, `vp run typecheck`, and
  `vp test run scripts/bibcode-identity.test.ts`.
- Run the packaged Mermaid spec on macOS arm64 with
  `BIBCODE_E2E_SPEC=./specs/mermaid-diagrams.e2e.ts`, after each issue lands:
  after #193 against the unchanged product, then after #190 and #191. Keep the
  JSON traces.
- Reviews: vercel-react-best-practices for the ChatView effect change (the
  listener stays ref-based and attaches once per thread), and UI.md for the
  behavior change (keyboard reading takes over from following, as the wheel
  does).
- Profiler coverage: none applies. No child processes, RPC methods, worktree
  removal, binaries, shutdown or profiler events are touched.

## Skipped (ponytail)

- No keyboard e2e (explained under #190).
- No post-commit landing recheck unless evidence shows one is needed (see
  #191).
- `onIsAtEndChange` does not restore following after a wheel or key cancel
  while `isAtEndRef` is already true. This is existing behavior for the wheel
  and is not changed here.
- Keys that a nested scroller inside a row consumes are not told apart from
  keys that move the timeline.
- No frame-count assertion for #193; the count is recorded in the trace only.
