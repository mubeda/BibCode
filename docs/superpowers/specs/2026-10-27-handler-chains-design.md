# Long-lived handlers in ChatView and ChatComposer (#204): design

Status: approved and implemented in three rounds; ChatComposer and ChatView render
scopes stay flat across changed reconnects (round 3 below). Plan:
[`2026-10-27-handler-chains.md`](../plans/2026-10-27-handler-chains.md).

## Approved changes (supersede the sections below where they differ)

- **Explicit error targets.** A stable `setThreadError` would pick the error store
  from the current route, so an operation that awaits (compaction, send, interrupt,
  approval and question answers, plan follow-up, revert, delivery resolution, project
  scripts) resolves `{ store, key }` (server store by environment-scoped thread key,
  or draft store) before its first await and writes there. `setThreadError` itself
  stays for synchronous callers and the composer prop.
- **Harness evidence per reconnect**: baseline and after each of the 8 changed
  reconnects.
- **Complete-caller test**: the real ThreadErrorBanner button and the real
  ChatComposer form, rendered inside ChatView in the compiled lane.

## Measured rounds

ChatView scopes (`--var handleOpenProviderTerminalPanel`) after each changed reconnect:

| run      | base | 1  | 2  | 3  | 4  | 5  | 6  | 7  | 8  |
| -------- | ---- | -- | -- | -- | -- | -- | -- | -- | -- |
| before   | 17   |    | 29 |    | 41 |    |    |    | 65 |
| round 1  | 16   | 21 | 26 | 31 | 36 | 41 | 46 | 51 | 56 |
| round 2  | 16   | 21 | 26 | 31 | 36 | 41 | 46 | 51 | 56 |
| round 3  | 13   | 14 | 15 | 15 | 15 | 15 | 15 | 15 | 15 |

ChatComposer scopes (`--var submitComposer`): before 10 / 14 / 18 / 26 at
base / 2 / 4 / 8; rounds 2 and 3 are 9 at base and at every one of the 8 reconnects.

Round 3's two scopes from base to changed-2 are not a chain: at changed-8 every
retained ChatView scope is one short path from a single holder (a
ComposerBannerStack memo cache holding the reconnect banner's actions, a menu's
`onFocus` props, the overlay measurement effect's `updateHeight`), each replaced
when its holder next renders, and none grows from changed-2 to changed-8.

Round 1 removed the composer chain and the `refuseWhileEnvironmentUnavailable <->
onCompactConversation` pair (6 to 5 per reconnect). Round 2 wrapped
`handleOpenProviderTerminalPanel`; the series did not move and the same paths
re-routed through `openReservedRightPanelTerminal`.

## Revised premise (after two rounds)

The remaining chain is a hub, not pairs. Every top path at changed-8 alternates
`getActiveTimelineTurnMetrics` with a different partner each round
(`handleOpenProviderTerminalPanel`, then `openReservedRightPanelTerminal`,
`onImplementPlanInNewThread`). Its only input, `composerOverlayHeight`, changes at
renders where most other callbacks do not, so any callback recreated at other
times pairs with it. Wrapping partners one at a time cannot converge.

## Round 3 (approved and implemented)

Stop the hub from recreating: `getActiveTimelineTurnMetrics`,
`timelineRealContentOverflowsViewport` and `pageTimeline` all depend on
`composerOverlayHeight` and recreate at the same render, so all three change
together. A latest handler is unsafe here: LegendList calls ChatView's
`onAnchorReady` (via `useStableAnchorCallbacks`) and `onRowSizeChanged`, which
reach these helpers through `settleSentTimelineRow`, `followTimelineLiveEnd` and
`followGrownTurn`, from its own measurement callbacks, possibly in a child layout
effect, where a latest handler would read the previous render. The three helpers
read `composerOverlayHeightRef`, written where the overlay is measured (its layout
effect and ResizeObserver callback, beside `setComposerOverlayHeight`), so they
keep one identity. The measurement runs before the render that commits the height,
so a LegendList callback in that commit's child layout effects already reads the
new height; a mirror written in ChatView's own layout effect would lag there, and
one written during render would stop the React Compiler. The live-end follow
effect, which used to re-run because the helpers' identity changed with the
height, now lists the height itself. The timeline-follow agent's work had merged,
so this change owns the helpers.

## Problem

With the React Compiler on, every closure created in one render of a component
shares that render's V8 context, which holds every variable any of those
closures reads. A memoized callback kept from render M therefore keeps render
M's whole context, including the versions of the other memoized callbacks that
were current at M. Two callbacks whose dependencies change at different renders
(each once per changed reconnect) form an alternating chain: render N holds
`A` from M, M holds `B` from L, L holds `A` from K, and so on. Every changed
reconnect adds links. #198 broke the composer's menu-select / attachment /
file-input chain with a file-local `useLatestHandler` in `ChatComposer.tsx`.

## Measurement on this branch

Chromium heap harness (#134/#198 recipe, see the plan), 100 turns of 60 kB
prompts, 2 unchanged then 8 changed reconnects, counting V8 contexts that have
a `handleOpenProviderTerminalPanel` slot (one per retained ChatView render):

| snapshot | baseline | changed-2 | changed-4 | changed-8 |
| -------- | -------- | --------- | --------- | --------- |
| scopes   | 17       | 29        | 41        | 65        |

About 6 ChatView render scopes per changed reconnect, as the issue reports.
Message-text copies are not the subject here (#198 keeps them flat).

All six top retention paths at changed-8 have the same head:

```
<form>.onSubmit -> submitComposer (composer render N)
  -> .shouldBlurMobileComposerOnSubmit (composer render M)
  -> .setThreadError (ChatView render, the prop that composer render received)
  -> .refuseWhileEnvironmentUnavailable <-> .onCompactConversation (alternating, repeated)
```

One path leaves the pair through `handleOpenProviderTerminalPanel ->
getActiveTimelineTurnMetrics -> onSteerHeadQueuedMessage`.

**Discrepancy with the issue:** the issue names a composer pair
`shouldBlurMobileComposerOnSubmit <-> resolveActiveComposerTrigger`. This run
shows `shouldBlurMobileComposerOnSubmit` only as the bridge from the composer's
`onSubmit` into ChatView via the `setThreadError` prop, and
`resolveActiveComposerTrigger` in no top path. It is wrapped only if a later
harness round names it.

## Decision: one shared `useLatestHandler` hook

Move the #198 hook unchanged to `apps/web/src/hooks/useLatestHandler.ts` and use
it in both components for long-lived handlers that form chains.

```ts
export function useLatestHandler<Args extends unknown[], Result>(
  handler: (...args: Args) => Result,
): (...args: Args) => Result; // one identity for the component's life
```

The returned function is created once inside the hook, so its context holds
only the ref; the ref holds the latest committed render's handler (one context,
not a chain). Semantics stay exactly as #198 shipped them: the ref updates in
`useLayoutEffect`.

**Safety rule (documented in the hook's JSDoc):** the result may be passed as a
prop and called from event handlers, async continuations, and `useEffect`
bodies. It must not be called during render, and a child must not call it from
its own `useLayoutEffect` (children's layout effects run before the parent's, so
they would see the previous render's handler).

### Alternatives considered

- **`useEffectEvent`:** rejected. These handlers are passed as props
  (`setThreadError` to ChatComposer) and called from event handlers, which
  `useEffectEvent` forbids (vercel-react-best-practices: Effect Event results
  must not be passed as props), and the repo pins react-dom 19.2's stale
  Effect Event defect in `memo`/`forwardRef` components
  (`reactEffectEventStaleness.test.tsx`).
- **One latest-ref handler object per component** (`handlers.current.x()`):
  same retention profile, but changes every call site's calling convention and
  hides handler names from props and tests. No gain over the hook.
- **Targeted dependency restructuring** (reading changing inputs from refs so a
  `useCallback` keeps its identity): rejected as fragile; one new dependency
  silently re-forms the chain, and it spreads ad hoc refs through ChatView.
- **Wrapping every handler ChatView passes to ChatComposer (~25):** skipped.
  Some are called during render (`getModelDisabledReason`), and it is a larger,
  non-mechanical change to the most-edited file in the batch. Wrap only the
  measured links.

### React Compiler interaction

The compiler cannot see through the ref, which is the point: the wrapper's
identity is constant, so callbacks that depend on it recompute less often. The
inner arrow passed to the hook is still memoized by its own captured inputs, so
`latest.current` keeps at most one older render context per wrapped handler
until its inputs change. That is bounded, so a one-time step between baseline
and changed-2 is possible; growth after changed-2 is not.

## Handlers that change (round 1, from the measurement)

| Component    | Handler                              | Role in chain         | Call sites (audited)                                                                                                              |
| ------------ | ------------------------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| ChatView     | `setThreadError`                     | bridge from composer  | event-time callbacks, async continuations, banner `onDismiss`, ChatComposer `addComposerAttachments` (a latest handler); no render-time or child layout-effect call |
| ChatView     | `refuseWhileEnvironmentUnavailable`  | alternating pair      | `runQueuedHeadAction`, `onSend`, `onRespondToApproval`, `onRespondToUserInput` (all event-time)                                    |
| ChatView     | `onCompactConversation`              | alternating pair      | `threadErrorActionValue.onClick` (click)                                                                                          |
| ChatComposer | `shouldBlurMobileComposerOnSubmit`   | composer-side bridge  | `submitComposer` (submit)                                                                                                          |

Behavior preservation: a stable `setThreadError` makes the callbacks that list
it (`runProjectScript`, `onRevertToTurnCount`, `onResolveTurnDelivery`,
`onRespondToApproval`, `onRespondToUserInput`, `onSubmitPlanFollowUp`,
`runQueuedHeadAction`) recompute less often. Two effects depend on those: the
window keydown listener (`runProjectScript`) and the layout effect that copies
`onRevertToTurnCount` into a ref. Both only re-subscribe or re-copy the latest
callback, and still re-run whenever the callback changes for any other input, so
running less often changes nothing observable. No handler in the table is read
during render or in a `useMemo` body (`threadErrorActionValue` only stores a
closure that calls `onCompactConversation` on click).

Later rounds: `ctx.mjs` prints the shortest path to each retained scope, so with
these links stable the paths re-route (for example through `onSend` or the
`handleOpenProviderTerminalPanel -> getActiveTimelineTurnMetrics ->
onSteerHeadQueuedMessage` branch). Each further round wraps only the links the
harness newly names, after the same call-site audit; at most two rounds before
replanning.

## Proof

- **Harness:** `handleOpenProviderTerminalPanel` scopes equal at changed-2,
  changed-4 and changed-8 (baseline 17 / 29 / 41 / 65), plus a composer-scope
  count (`--var submitComposer`) reported the same way.
- **Hook unit test** (`apps/web/src/hooks/useLatestHandler.test.tsx`, happy-dom,
  compiled lane): identity constant across renders with a changed handler; a
  call after commit runs the latest render's handler with its arguments and
  returns its result.
- **ChatView** (`ChatView.test.tsx`, mocked ChatComposer and ThreadErrorBanner):
  the composer's `setThreadError` prop keeps one identity across a rerender that
  changes the thread and connection state, and the first-captured function
  writes the error for the latest thread; the banner's compact action keeps its
  identity across such a rerender and runs the latest compaction path.
  `refuseWhileEnvironmentUnavailable` has no external identity: covered by the
  hook test, the existing #199 refusal tests (latest unavailable state), and the
  harness.
- **ChatComposer** (`ChatComposer.rerender.test.tsx`): a submit after a rerender
  that changes the mobile/busy inputs blurs (or keeps focus) per the latest
  render's inputs.
- Existing ChatView and ChatComposer suites pass unchanged.
