# Neutral chat composer focus color

## Context

The chat composer currently changes its border to the theme `ring` color when a descendant receives keyboard-visible focus. In both light and dark themes, that token is orange. Center-pane framing was recently changed to use neutral border colors, and the composer should follow the same visual treatment.

The orange composer focus color originates in `apps/web/src/components/chat/ChatComposer.tsx` from the `has-focus-visible:border-ring/45` utility on the composer surface. The surface already owns its normal neutral `border-border` class, while drag-over state separately selects `border-primary/70`.

## Approved outcome

- A focused composer uses the same neutral `border-border` color as an unfocused composer.
- Focus acquisition, focus state, keyboard interaction, border thickness, rounded shape, transitions, send controls, and provider controls remain unchanged.
- Drag-over feedback continues to use `border-primary/70`; removing the focus-color override must not mask that state.
- The result applies consistently in light and dark themes in both the web UI and the shared UI rendered by the Tauri desktop app.

## Design

Remove only `has-focus-visible:border-ring/45` from the composer surface class list. Do not add a redundant focus-specific neutral class: the existing `border-border` class already supplies the approved focused and unfocused color, and leaving the focus override absent preserves the independently selected drag-over border.

No state, event handler, component structure, theme token, shared input control, provider styling, or desktop bridge code changes. The owning package remains `apps/web`; there are no protocol, persistence, runtime-topology, security-boundary, or dependency changes.

## Alternatives considered

1. **Remove the focus-color override (approved).** Smallest change, makes focused and unfocused composer borders identical, and preserves drag-over styling.
2. **Use `has-focus-visible:border-border`.** Same normal rendering, but redundant and may override the drag-over border while the composer is focused.
3. **Use a stronger neutral focus color.** Retains a visible focus distinction, but does not meet the approved identical neutral-border treatment.

## Testing and validation

Use test-driven development in `ChatComposer.test.tsx`:

1. Add a focused rendering assertion that requires the composer surface to keep `border-border` and rejects the `has-focus-visible:border-ring` override while preserving focus handlers and drag-over styling.
2. Run the focused test first and confirm it fails because the orange focus class is still present.
3. Remove the single focus-color utility and confirm the focused test passes.

Then run the applicable repository gates: the focused composer test file, `vp check`, and `vp run typecheck`. Build and launch the exact Tauri desktop bundle in a fresh process, capture light and dark screenshots with the composer focused, and inspect the composer border pixels to confirm neutral grayscale framing. Also confirm the existing pane frames remain neutral and focus behavior is unchanged.

## Out of scope

- Changing the orange send button, provider/model icon accents, terminal prompt colors, or other focus indicators.
- Changing the shared `--ring` theme token.
- Changing panel focus behavior or any composer interaction behavior.
