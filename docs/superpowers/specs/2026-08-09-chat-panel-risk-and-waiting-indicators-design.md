# Chat panel risk and waiting indicators

## Context

The normal chat composer already exposes runtime access and provider reasoning
controls as compact icon-only toolbar buttons. Their current neutral treatment
does not distinguish the most permissive runtime mode or the most expensive
reasoning level. The active-turn timeline separately shows three pulsing dots
and a whole-second `Working for` timer, which makes short waits feel less
responsive than the underlying stream.

The approved visual examples add risk emphasis without changing toolbar layout
and replace the waiting row with a more informative, compact activity indicator.
The result must work in both light and dark themes and in the shared React UI
used by browser and Tauri desktop modes.

## Approved outcome

### Full Access

- When runtime mode is `full-access`, the toolbar lock icon uses the theme's red
  destructive color in light and dark themes.
- The Full Access option's lock icon uses the same red treatment inside the
  runtime-mode selector.
- The toolbar remains icon-only. The selector title, description, selected
  checkmark, container, and every other runtime mode retain their existing
  neutral styling.
- Existing labels, tooltips, selection behavior, and accessibility semantics
  remain unchanged.

### Highest provider reasoning level

- When the selected reasoning value is the final option in the active
  provider/model's ordered reasoning descriptor, the toolbar bars use the
  theme's red destructive color.
- The selected highest option's title uses the same red treatment inside the
  reasoning menu. The menu checkmark and row chrome remain neutral.
- The policy is provider- and label-independent. It therefore applies to
  `Ultra`, `Max`, `Extra High`, or any future name when that option is last in
  the provider-supplied descriptor.
- Lower reasoning selections, unavailable reasoning controls, and pending
  updates retain their existing styling.
- The toolbar remains icon-only and does not add the selected reasoning label.

### Waiting row

- Replace the three-dot pulse with an eight-dot square activity icon positioned
  before the message with the existing 8px row gap.
- Animate the dots in the user-approved reversed paint-and-fade direction.
- The icon is decorative and hidden from assistive technology. The text remains
  the accessible status content.
- Change the copy from `Working for` to `Waiting for`.
- Show elapsed seconds with one decimal place, representing 100ms precision,
  for example `Waiting for 3.8s`.
- Preserve readable duration units by rendering minute and hour components
  before a one-decimal seconds component for longer waits.
- Invalid timestamps fall back to `0.0s`; negative elapsed values clamp to
  zero.
- The timer updates its own text node every 100ms so the timeline does not
  create React commits while a provider response is streaming.
- The animation uses muted theme foreground colors and becomes static when the
  user requests reduced motion.

## Design

### Ownership and data flow

`apps/web` owns all three changes. No provider protocol, contract, persistence,
server, client-runtime, or desktop-bridge change is required.

- `ChatComposer.tsx` continues to own runtime-mode presentation. It derives the
  red state directly from the already-selected `RuntimeMode`.
- `TraitsPicker.tsx` continues to own reasoning presentation. Its existing
  provider/model capability resolution supplies both the ordered option list
  and selected value. One shared local policy determines whether that value is
  the descriptor's final option and is used by the toolbar and menu rendering.
- `MessagesTimeline.tsx` continues to own the waiting row and its self-ticking
  timer. The timestamp remains the source of truth; the interval never
  increments a separate elapsed counter, so delayed browser scheduling cannot
  accumulate drift.

### Theme treatment

Use the existing `text-destructive` theme token rather than hard-coded red
values. The token already resolves to suitable light- and dark-theme reds.
Only the approved icon or title node receives the token, preventing selected
checkmarks and surrounding controls from inheriting red accidentally.

### Waiting animation

The square is a fixed 16px decorative wrapper containing eight absolute dots.
Dots use one shared keyframe and staggered negative delays. The delay order is
the reverse of the original visual proposal, producing the approved direction
without a GIF, image request, or continuously allocated JavaScript animation.
CSS owns motion; JavaScript is limited to the existing elapsed-text update.

`prefers-reduced-motion: reduce` disables the keyframe and leaves a stable,
visible square. The timer continues updating because elapsed information is
functional status rather than decorative motion.

## Failure, lifecycle, and performance behavior

- Provider switches and model switches immediately recompute the highest-level
  state from the newly active descriptor; no provider name or option label is
  cached.
- A missing descriptor, missing selection, or selection not found in the
  descriptor cannot activate the red reasoning treatment.
- Prompt-injected reasoning values use the same resolved selection already used
  by the control, including Claude Ultrathink behavior.
- Pending reasoning changes continue to display the existing loading icon and
  do not falsely color that loader as a confirmed highest selection.
- Reconnects and restarts need no special handling because selected runtime and
  model options already flow through existing state ownership.
- Waiting updates perform one text-node write at most every 100ms and no React
  state update. The CSS animation is bounded to eight tiny elements and uses
  opacity and transform only.
- Interval cleanup remains tied to component unmount and timestamp changes, so
  completed or replaced turns do not retain timers.

## Testing and validation

Use test-driven development for each observable behavior:

1. `ChatComposer.test.tsx`
   - Full Access gives the trigger icon and the Full Access menu icon
     `text-destructive`.
   - The trigger remains icon-only, surrounding copy stays neutral, and other
     runtime modes do not receive the red class.
2. `TraitsPicker.test.tsx`
   - Different provider descriptors whose highest options have different names
     both activate the red toolbar bars and selected menu title.
   - A lower option remains neutral.
   - The selected checkmark does not inherit the title's red class.
3. `MessagesTimeline.test.tsx`
   - The row renders the square's eight dots before `Waiting for`.
   - The short timer uses one decimal place, invalid timestamps use `0.0s`, and
     minute/hour boundaries retain correct units with a decimal seconds part.
   - A mounted timer schedules 100ms updates and cancels its interval on
     cleanup.
4. Verify the animation definition, reverse delay order, muted theme token, and
   reduced-motion override through focused source/markup assertions and visual
   inspection in both themes.

After focused tests, run the web package tests proportional to the change,
`vp check`, `vp run typecheck`, and a web build. Review the final diff and
worktree status for generated files, unrelated edits, and missing documentation.

## Living documentation

Update `docs/user/workspace-ui.md` with the user-visible composer warning states
and waiting-row format. No living architecture document changes because package
ownership, protocol flow, persistence, runtime topology, lifecycle guarantees,
and trust boundaries remain unchanged.

## Alternatives considered

1. **Descriptor-driven state with theme tokens and CSS animation (approved).**
   Covers every provider without hard-coded names, reuses theme semantics, and
   keeps animation off the React render path.
2. **Hard-code `Ultra`, `Max`, and provider identities.** Rejected because
   provider capabilities and labels evolve, creating a second source of truth.
3. **Use a GIF or request-animation-frame component for the dotted square.**
   Rejected because a CSS keyframe is themeable, scales cleanly, respects
   reduced motion, and avoids asset and render-loop overhead.
4. **Render three millisecond digits.** Rejected after visual review because the
   rapidly changing text was noisy; one decimal preserves responsive feedback.
5. **Color entire selected rows red.** Rejected because the approved design
   emphasizes only the risk-bearing icon or title while retaining neutral
   checkmarks and selection chrome.

## Out of scope

- Changing access or reasoning semantics, defaults, persistence, or provider
  dispatch behavior.
- Adding toolbar text labels.
- Coloring Fast, Plan, context-window, MCP, send, or other composer controls.
- Adding notifications, confirmations, or policy enforcement for Full Access or
  high reasoning.
- Changing completed-turn duration presentation outside the active waiting row.
