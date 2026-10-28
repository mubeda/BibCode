# Timeline follow batch: #193, #190, #191 (plan, round 2)

Branch `claude/b3-timeline-follow` from `origin/develop` at 27702287cc. Order:
#193 first, so the Mermaid spec is strict before it validates #190 and #191.

Round 2 addresses the coordinator's review of round 1:

- #191: LegendList can defer, clamp and supersede scroll requests.
- #190: a sent row's glide can restart after the reader released it.
- #190: real keyboard input in the packaged app.
- #193: the spec must not pass when nothing was sampled.
- Docs: the architecture note and the runbook.

## Owned files

- The follow, scroll, sent-row and glide code in `apps/web/src/components/ChatView.tsx`
  (about lines 3984 to 4455), and the follow tests in
  `apps/web/src/components/ChatView.hooks.test.tsx`.
- `apps/web/src/components/chat/timelineScrollAnchoring.ts` and its test.
- `apps/desktop/e2e/specs/mermaid-diagrams.e2e.ts`.
- `docs/architecture/overview.md`, beside the Reading position paragraph (about
  line 3038). The coordinator granted this.
- `docs/testing/cross-platform-validation.md` and `docs/user/workspace-ui.md`.

I won't touch the ActivityDockBinding region or the activity panel layout.

**Needs approval: two files outside the owned set.**

1. `patches/@legendapp__list@3.3.10.patch` gains one imperative method,
   explained under #191 step 3.
2. `apps/desktop/e2e/support/mermaid-fixture.ts` gains one slower streamed
   prompt for the keyboard test in #190.

If either is refused, the fallbacks are:

1. Instead of the patch: a no-op superseding request through the public API.
   I'll describe its gap below.
2. Instead of the new prompt: reuse `streamedPlain`, which gives a shorter time
   window to check.

## What LegendList does with ChatView's scroll requests

These facts are read from `apps/web/node_modules/@legendapp/list/react.mjs`,
version 3.3.10.

- **Deferral.** `scrollToOffset`, `scrollToIndex` and `scrollToEnd` all go
  through `runScrollWithPromise` (lines 7423-7427, 7544-7579). Each request
  takes a new token from `scrollRequestTracker.start` (line 1425). That call
  cancels the previous request's pending `imperativeScrollReady` frame and
  resolves its promise. The previous request's work stops at once, even if the
  new request is itself deferred.
- **When it defers.** While `isSettlingAfterDataChange()` holds
  (`didDataChange`, a scheduled `mvcpRecalculate`, or `ignoreScrollFromMVCP`),
  the request waits for 2 stable frames, or at most 800 ms
  (`IMPERATIVE_SCROLL_SETTLE_MAX_WAIT_MS`, lines 7375-7422). That happens on
  most frames while a reply streams. It then runs `scrollTo` with the offset
  computed when the request was made.
- **Native scrolling does not cancel a deferred request.** A wheel or key scroll
  leaves it queued. Only another request, `onScrollBeginDrag` (line 8416, which
  the web scroller receives as `onInternalScrollBeginDrag` at line 6691 but
  never calls), or unmount (line 8392) cancels it. Unmount calls
  `cancelImperativeScroll` (lines 426-432).
- **Clamping.** `scrollTo` clamps the offset to LegendList's own laid-out
  content size minus the viewport (`clampScrollOffset`, lines 1269-1282). That
  content size can lag the DOM.
- **Deferred adjustments.** During an animated scroll, MVCP adjustments are
  held as `pendingAdjust` (`ScrollAdjustHandler`, line 7227). They are
  committed in `finishScrollTo`: for an index target, it lands at LegendList's
  own position for that index (lines 1300, 7237-7250). The animated glide's
  `listenForScrollEnd` reaches `finishScrollTo` on idle or after 1.5 s, even
  after the reader takes over (lines 1364-1419).
- **Repeated ready callbacks.** `maybeUpdateAnchoredEndSpace` calls
  `anchoredEndSpace.onReady` again whenever the end space's size or anchor
  changes (lines 4781-4793). That happens with each streamed delivery.

**What this means for today's code.** The pin and the follow pass are
`scrollToOffset` requests, and the glide is a `scrollToIndex` request. Any of
them can still be queued, or the glide still unfinished, when the reader takes
over. When it runs later, it moves the reader.

Three commits before #183's revert tried to deal with this:

- 18546f200c landed with `scrollToIndex` and waited up to 1 s.
- 2bccc70282 superseded a queued landing with "a scroll to the current offset".
- cc7295155c kept the marker until the landing was confirmed.

Two of those ideas are not reused here. Waiting before settling delayed every
follow, which failed the macOS streamed-follow test 2 out of 2 times. A
superseding scroll to the current offset is itself deferred, so it later runs
with a stale offset. Neither applies to the design below.

## #193: the streamed-follow check is only as strict as its plain baseline

**Acceptance criterion.** In "follows the end while a streamed reply's diagram
draws":

- Once the plain reply's sent row has settled, every delivery after its code
  block shows rests with the reply's end revealed (`endBelow <= 1`).
- The check cannot pass without observations. At least 5 of the deliveries
  after settling must have a painted rest, and so must the last line.
  Otherwise the spec fails and lists the delivery keys it sampled.
- The diagram reply's existing check gets the same minimum of observed rests.

**Root cause.** `mermaid-diagrams.e2e.ts:1020-1022`: `revealedBelow(d)` reads
`plainRests`, and nothing asserts on `plainRests` itself.

**Arithmetic for the minimum.** The fixture streams 15 deliveries, one every
300 ms: the intro at 0, the fence at 300, after-paragraphs 1 to 12 at 600 to
3900, and the last line at 4200. Even the latest settle point
(`SENT_ROW_SETTLE_MS`, 2.5 s) leaves 7 deliveries: after-paragraphs 7 to 12
plus the last line. Requiring 5 of them allows for the slow webview the spec
already describes, which can paint no frame between two deliveries.

**Change (spec only).**
- Move the settle-point expression into a `settledFrom(samples)` helper
  (lines 1023-1032) and use it for both replies.
- Collect each reply's hidden rests as labelled objects:
  `{ reply, delivered, at, endBelow, settledFrom }`. Assert both lists with
  `toEqual([])`.
- Collect the sampled delivery keys from the settle point on, and assert the
  minimum with a message that names them.
- Record each delivery's painted-frame count until its end is revealed in the
  trace. This is for diagnosis only. A frame-count bound would be flaky, since
  a follow takes a commit plus two frames, plus up to six double-frame
  rechecks when LegendList clamps it.
- Update the comment block at lines 1008-1019.

**Proof.**
- The spec passes on this Mac (packaged, macOS arm64) against the unchanged
  product.
- The new assertions can fail. A throwaway local edit that skips the follow
  pass makes the plain list non-empty. A second one that drops samples after
  settling trips the minimum. Neither edit is committed.
- If the local plain rests sit consistently above 1 px, I'll report that as a
  product finding and not widen the bound.

## #190: arrow keys do not stop live following

**Acceptance criterion.**

1. When focus is inside the timeline scroller (not the composer), these keys
   stop live following and the anchored turn's growth follow, the same way the
   wheel, touchmove and pointerdown do: ArrowUp, ArrowDown, PageUp, PageDown,
   Home, End, Space, and Shift+Space.
2. A key that would move nothing does not stop following. Neither does a key
   that the focused control owns.
3. Once the reader has released a sent row, it stays released until the next
   send or a thread change. A repeated `onReady` for that row neither glides
   nor pins.
4. Packaged proof with real WebDriver input:
   - the key moves the view;
   - the reading position holds through the glide settling, LegendList's
     deferral window and later streamed growth;
   - End returns to the end and following resumes.

**Root cause.**
- `ChatView.tsx:4113-4135` binds only wheel, touchmove and pointerdown.
  `pageTimeline` (lines 4079-4100) cancels only for keys pressed in the
  composer.
- `cancelTimelineLiveFollowForUserNavigation` (lines 3998-4011) clears
  `positionedTimelineAnchorRef`. A later `onTimelineAnchorReady` for the same
  message (line 4144), which LegendList re-fires with every delivery, then
  starts the glide again and takes the reader back to the sent row.
- The test at `ChatView.hooks.test.tsx:1997-2006` encodes that restart: it
  expects a second `scrollToIndex` after a wheel.

**Change.**
1. **Key classification.** Add a pure helper to `timelineScrollAnchoring.ts`,
   `keyboardScrollStopsLiveFollow(event, scroller)`. It returns true only when
   all of the following hold:
   - the key is one of the eight above;
   - the event is not `defaultPrevented` (a control, or the window's
     capture-phase shortcut handler, owned it);
   - the target is not editable (`input`, `textarea`, `select`, or
     `isContentEditable`);
   - Space is not pressed on a control (`TIMELINE_CONTROL_SELECTOR`);
   - the key can still move the list. A down key at
     `scrollTop >= scrollHeight - clientHeight - 1`, or an up key at
     `scrollTop <= 1`, does not count. This mirrors lines 4091-4094.
2. **Listener.** Add a passive `keydown` listener on the scroll node, in the
   same effect as the other three. It calls the same cancel.
3. **Released sent row.** Add a `releasedTimelineAnchorRef`.
   - The cancel sets it to the positioned anchor, then the pending anchor, then
     keeps its previous value.
   - `onTimelineAnchorReady` for a released message records the anchor index
     and marks the row positioned and settled, without scrolling. The row then
     goes on holding the reader's place through `onTimelineAnchorSizeChanged`.
     That handler acts only once following is off, which it now is.
   - The send paths that set `pendingTimelineAnchorRef` (lines 5968 and 6550)
     clear the released row, and so does the thread reset effect (line 4466).
4. **Withdrawing queued scrolls.** The same cancel withdraws any scroll
   ChatView left queued in LegendList (see #191 step 3), so a queued glide,
   pin, landing or follow cannot run over the reader.
5. **Resuming at the end.** No change is needed. After the reader scrolls away,
   `handleScroll` reports `isAtEnd` false and then true, on every scroll, and
   `onIsAtEndChange` (lines 4241-4262) switches back to `following-end`. The
   hooks test below covers it.
6. Change the comment at `ChatView.hooks.test.tsx:1948` to "a scroll the
   timeline does not see as the reader's own".

**Tests.**
- **`ChatView.hooks.test.tsx`.** The fake scroll node's `fire(type, event?)`
  passes an event, and the node exposes `scrollHeight` and `clientHeight`.
  - The listener assertion at lines 1719-1721 includes `"keydown"`.
  - In `sendTallReply`, ArrowUp from inside the scroller before `scrollend`:
    the settle neither pins nor follows to 216. This fails before the fix.
  - ArrowDown at the end, a textarea target, and Space on a button each keep
    following on.
  - Repeated ready (rewrites lines 1973-2008). After a takeover,
    `onAnchorReady` for the same message twice adds no `scrollToIndex` and no
    `scrollToOffset`. A later size change holds the reader's offset. A new
    send's ready glides again.
  - After a takeover, an `isAtEnd` report of false and then true restores
    following: the next `timelineEntries` change calls `scrollToEnd`.
- **`timelineScrollAnchoring.test.tsx`.** A table of the helper's cases.
- **Packaged test (complete caller).** A new
  `it("hands the timeline to the reader's keyboard and resumes at the end")` in
  `mermaid-diagrams.e2e.ts`. It needs a slower streamed prompt, about 30
  after-paragraphs at 300 ms (about 10 s), so the windows below fit.
  1. Start the painted-frame sampler, extended with the top of a chosen reading
     paragraph and the sent row's top. Then send the prompt.
  2. On the first painted frame showing the sent row, focus a control inside
     the timeline: the previous reply's code-block **Copy** button.
     `focus({ preventScroll: true })` does not fire pointerdown, so following
     continues. Then send real input with `browser.keys(["PageUp"])` and a
     second `ArrowUp`.
  3. Assert that the view moved up by at least half a page, and that the key
     reached the scroller as one trusted keydown, recorded by a capture
     listener.
  4. Assert that the reading line, read once two painted frames agree, stays
     within 1 px on every painted frame for 3 s. That window covers the 750 ms
     settle, LegendList's 800 ms deferral, and at least 5 deliveries, which are
     counted and asserted.
  5. Send `browser.keys(["End"])`. Assert that the view reaches the end and
     that every later delivery rests revealed (`endBelow <= 1`), with at least
     3 of them.
  6. The trace (`mermaid-timeline-keyboard-takeover.json`) records the key
     times, the settle time inferred from the sent row's motion, and the
     samples.

  **Risk.** `keyboard-input.ts:160-166` notes that WebKit can deliver
  WebDriver key events without their native default action. If, on this Mac,
  the key arrives but the view does not move, I'll stop and report it rather
  than fall back to synthetic events, because they prove nothing here. The
  spec reports that case as "the driver delivered keydown, but the webview did
  not scroll", so a Linux run on CI explains itself.

**Docs.** `workspace-ui.md`, after the PageUp/PageDown paragraph: scrolling the
timeline yourself stops it following a streaming reply. That includes the
wheel, a touch, the scrollbar, and the keyboard while the timeline has focus.
Returning to the end resumes following.

## #191: the sent row can settle a few pixels short of its offset

**Acceptance criterion.**

- After a send whose turn fits in the view, the sent row's top settles within
  1 px of `CHAT_LIST_ANCHOR_OFFSET` (16 px), measured in the DOM. This is what
  `mermaid-diagrams.e2e.ts:641-643` reads.
- For a turn taller than the view, the sent row never rests below its offset
  after settling, because following takes it above.
- Settling and the follow pass keep today's timing, with no wait.
- A queued landing completes or is withdrawn on every path, and it never moves
  a reader who took over.

**Root cause.** `ChatView.tsx:4178-4179` pins `getState().scroll` on
`scrollend` or the 750 ms timer. At the timer, a slow webview's glide is still
moving, or has not started (the glide's `scrollToIndex` can itself wait up to
800 ms in `runWhenReady`). LegendList's state also lags a smooth scroll. So the
pin stops the row 11-16 px short.

**Change.**
1. **Measure.** In `finishAnimatedPositioning`, find the row with
   `scrollNode.querySelector('[data-message-id="<CSS.escape(id)>"]')`.
   `MessagesTimeline.tsx:1194` renders this attribute, and the spec measures
   the same element. The pure helper `getSentRowLandingDelta(rowTop,
   viewportTop, anchorOffset)` returns null within 1 px.
   - The target is the DOM `scrollTop + delta`, falling back to today's pin
     when the row is missing or the delta is null.
   - Issue one `scrollToOffset({ offset: target, animated: false })`. As a new
     request, it supersedes the glide's request synchronously (the token).
   - Then set `settledTimelineAnchorRef` and run the follow pass two frames
     later, exactly as today.
2. **Track it.** `timelineLandingRef` holds `{ messageId, generation, threadId,
   request }`, where `request` counts every scroll request ChatView makes:
   - glide;
   - pin or landing;
   - follow;
   - recheck;
   - a toggle's reveal;
   - `scrollToEnd`.

   This sits behind one small `requestTimelineScroll(kind, run)` wrapper, so
   ChatView knows which request is outstanding and when its promise resolves.
3. **Withdraw it on takeover.** A takeover means wheel, touchmove,
   pointerdown, keydown, the composer's PageUp/PageDown, the minimap, or find
   (`onManualNavigation`). While ChatView has a request outstanding, the
   takeover withdraws it before the reader's scroll proceeds, through a new
   patched imperative method:

   - **`cancelScrollRequests()`.** It calls LegendList's internal
     `cancelImperativeScroll(state)`, which is what LegendList itself does when
     a drag begins. That cancels the queued `imperativeScrollReady` frame, the
     completion checks and `scrollingTo`, and resolves the promise.
   - **It drops the cancelled scroll's held `pendingAdjust`.** That adjustment
     compensated content the reader has now seen move. Committing it on the
     next `finishScrollTo` would shift the view.
   - **Patch shape.** The patch extends the existing one in `react.js` and
     `react.mjs`. ChatView reaches the method through a narrow typed interface
     and checks that it exists.
   - **Fallback.** With no patch, the public-API fallback is a no-op superseding
     request, `scrollToItem` with an item that is not in the data (lines
     7567-7575): it takes the token and scrolls nothing. Its gap is that an
     animated glide already moving keeps `scrollingTo`, and its `finishScrollTo`
     can still commit `pendingAdjust` to the index position. That is why the
     patch is preferred.
4. **Complete or cancel on each path.**
   - **Settles normally.** When the landing's promise resolves, ChatView checks
     the row once more, and only while all of these still hold:
     - the generation, positioned anchor and thread are unchanged;
     - the mode is `anchoring-new-turn` and following is on;
     - the turn fits the view (`overflowsUsableViewport` is false), so the
       follow pass never scrolls.

     If the row is still off by more than 1 px, ChatView issues exactly one
     more landing. That covers a deferred landing that ran with a stale target,
     a clamp to a content size that lagged, and a committed `pendingAdjust`.
     There is no further retry, and the residual offset goes to the trace.
   - **Follow pass.** For a turn taller than the view, the follow's request
     supersedes the landing, and the guard above skips the recheck. The turn's
     end is the target there, so the follow pass wins by design.
   - **Reader takes over.** Step 3 withdraws the request, and the bumped
     generation fails the recheck guard. The row stays released (#190 step 3),
     so a re-fired ready cannot start positioning again.
   - **New send.** The next glide's request supersedes the landing (the token),
     and the positioned anchor changes, which fails the guard.
   - **Thread change.** The timeline remounts (it is keyed by thread).
     LegendList's unmount cancels and resolves the request (line 8392), and the
     thread reset effect (line 4466) clears the anchor refs, which fails the
     guard.
5. **Anchor size changes.** `onTimelineAnchorSizeChanged` (lines 4199-4239)
   returns early while following. The landing does not rely on it. After a
   takeover it holds the reader's offset, which is unaffected because any
   queued landing was withdrawn first.

**Tests.**
- **`timelineScrollAnchoring.test.tsx`.** `getSentRowLandingDelta`: row low,
  row high, within 1 px, missing.
- **`ChatView.hooks.test.tsx`.** The fake list gains a deferrable
  `scrollToOffset`: the test holds its promise and runs it later. It also gains
  `cancelScrollRequests`, a fake row from `querySelector`, and
  `getBoundingClientRect`.
  - `scrollend` with the row 12 px low lands at `scrollTop + 12`. The timer
    path, with fake timers, does the same.
  - A missing row keeps today's pin, so the tests at lines 1844-1912 are
    unchanged.
  - A deferred landing, then a keydown: `cancelScrollRequests` is called before
    the reader's scroll, and the deferred run never moves `scrollTop`.
  - A deferred landing, then a new send's ready: the new glide is issued and the
    recheck never runs.
  - A deferred landing, then a thread change: no recheck and no scroll.
  - A landing resolving with the row still 5 px off, while the turn fits: one
    recheck lands it. The same case with an overflowing turn: no recheck.
  - A deferred follow request, then a wheel: the request is withdrawn.
- **Packaged.**
  - The sent-row check at lines 641-643 asserts on a labelled object
    (`{ top, expected: 16, off }`).
  - `streamAndSampleEnd` also samples the sent row's top. From the settle point
    on, every painted frame of both streamed replies keeps the row at or above
    its offset plus 1 px, and labelled failures give the frame and the offset.
    This is the stream-scenario proof that the landing is never short and that
    the follow pass takes over for a tall turn.
  - The keyboard test (#190) proves that a queued request never moves a reader
    who took over during the glide.
  - Both run on this Mac. Windows and Linux evidence comes from CI. This Mac
    cannot reproduce the short landing, so here it shows only that nothing
    regressed.

## Docs

- **`docs/architecture/overview.md`.** A new "Timeline following and sent-row
  settling" paragraph beside Reading position (about line 3038). It covers:
  - the three modes, and what stops following: wheel, touch, pointer press
    off a control, scroller keys, composer paging, the minimap, and find;
  - that a takeover withdraws ChatView's queued LegendList scroll requests
    (through the patch method);
  - that a released sent row stays released until the next send;
  - that the glide settles on `scrollend` or after 750 ms, with one landing
    measured in the DOM and at most one recheck;
  - how the landing completes or is cancelled on a takeover, a new send and a
    thread change.

  It also adds the new patch method to the existing sentence about
  `patches/@legendapp__list@3.3.10.patch`.
- **`docs/testing/cross-platform-validation.md`.** The Mermaid paragraph (lines
  3136-3172) gains three points:
  - both replies' rests are bounded once settled, with the minimum of observed
    rests;
  - the sent-row bound in the streams;
  - the keyboard takeover check, with real WebDriver keys on a focused timeline
    control: the view moves, the reading line holds through settling and
    growth, and End resumes following (`mermaid-timeline-keyboard-takeover.json`).

  The section at lines 2957-2965 gains a manual-step clause: keyboard scrolling
  in the timeline stops following, and End resumes it.
- **`docs/user/workspace-ui.md`.** One sentence, as under #190.

## Validation (phase 2)

- Run `vp test run --project unit` from `apps/web` for
  `src/components/chat/timelineScrollAnchoring.test.tsx`,
  `src/components/ChatView.hooks.test.tsx`, `src/components/ChatView.test.tsx`,
  `src/components/chat/ChatComposer.test.tsx` and
  `src/components/chat/MessagesTimeline.test.tsx`.
- Run `vp check --no-fmt`, `vp check <changed files>`, `vp run typecheck`, and
  `vp test run scripts/bibcode-identity.test.ts`.
- After the patch edit, reinstall and check that `react.mjs` and `react.js`
  carry the method.
- Run the packaged Mermaid spec on macOS arm64
  (`BIBCODE_E2E_SPEC=./specs/mermaid-diagrams.e2e.ts`) after #193, against the
  unchanged product, and again after #190 and #191. Keep the JSON traces.
- Review against vercel-react-best-practices: the listeners stay ref-based and
  attach once per thread, and there is no new state or re-render. Review
  against UI.md: the keyboard takes over like the wheel, and End resumes.
- Profiler coverage: none applies. No child processes, RPC methods, worktree
  removal, binaries, shutdown, or profiler events are touched.

## Skipped (ponytail)

- No frame-count assertion for #193; the counts go in the trace only.
- No retry beyond the one landing recheck.
- A wheel down at the very end still stops following without moving. That is
  existing behavior; only keys get the "nothing would move" guard.
- Keys consumed by a nested scroller inside a row are not told apart.
