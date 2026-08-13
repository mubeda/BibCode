# Activity Control-Unavailable Presentation Design

**Date:** 2026-08-13

**Status:** Approved in conversation; pending written-spec review

## Summary

Make the Subagents roster explain why an observed active actor has no Stop
button. Durable actor lifecycle and ephemeral targeted-cancellation authority
remain separate: an actor may still be observed as `running` after its exact
current-runtime provider target has been retired or invalidated.

## Approved Design

For an active actor in the structured thread Subagents mutation surface:

- an `available` control renders **Stop** or **Stop subtree**;
- a `requested` control renders disabled **Stopping**;
- no current `available` or `requested` control renders non-interactive
  **Stop unavailable** in the same trailing action column; and
- the row's lifecycle label remains **Running**.

The unavailable label is presentation only. It is not a button, has no
tooltip, performs no RPC, and cannot be focused as an action. This preserves
the fail-closed boundary: an absent private target never becomes a guessed,
stale, root, sibling, or semantic fallback cancellation.

Terminal actors, background-task rows, terminal Activity scopes, and providers
without the targeted-cancellation mutation surface retain their existing
read-only presentation.

## Alternatives Considered

1. **Recommended and approved: retain Running and add Stop unavailable in the
   action column.** This explains the missing action without conflating
   observation and control state.
2. Replace **Running** with **Control unavailable**. Rejected because the actor
   lifecycle may still be running; control availability is an independent
   dimension.
3. Render a disabled **Stop** button. Rejected because disabled action chrome
   implies a temporarily actionable command and competes visually with the
   server-authoritative disabled **Stopping** state.

## Ownership and Boundaries

- `apps/web` owns this presentation and its DOM/accessibility tests.
- Existing contracts, client-runtime reduction, server overlay state, RPC,
  provider dispatch, persistence, and cancellation semantics remain unchanged.
- The UI derives the label only from the already-joined canonical actor record,
  the eligible mutation callback, and the server control overlay. It does not
  infer descendants or native targets locally.

## Verification

### Automated

- RED/GREEN real-DOM coverage for an active actor with no current control.
- Preserve available Stop, requested Stopping, terminal/background omission,
  hierarchy, keyboard focus, and streamed-control precedence coverage.
- Run the focused Activity roster/panel/surface tests, web typecheck,
  `vp check`, and workspace typecheck.

### Packaged visual/provider review

Build and launch exactly one release bundle from this worktree. Through Codex
Computer Use, capture and inspect original-resolution and enlarged crops for:

- persisted active actors showing **Running** plus **Stop unavailable**;
- fresh Codex parent/child/sibling actors showing non-overlapping Stop actions,
  selected-subtree isolation, and the expected terminal result; and
- fresh Claude parent/child/sibling actors showing the same presentation and
  exact `stop_task`-backed isolation when the installed provider is
  authenticated.

If Claude authentication or provider readiness blocks the live packaged test,
capture that exact UI state and run the existing authenticated production
fixture/RPC coverage; do not claim a live Claude pass.

Pixel review must check action/status spacing, hierarchy indentation,
focus-ring completeness, clipping, provider-icon multiplicity, and raw native
identifier leakage at normal and narrow widths.

## Residual Risk

Provider observation may remain `running` indefinitely when a provider never
publishes a terminal lifecycle. The new label makes the loss of exact Stop
authority explicit but does not invent a terminal actor transition.
