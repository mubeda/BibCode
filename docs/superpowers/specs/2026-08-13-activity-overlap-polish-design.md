# Activity Overlap Polish Design

**Date:** 2026-08-13

**Status:** Approved in conversation; pending written-spec review

## Summary

Remove the two remaining visual collisions found during packaged-app review:

- compact Activity dock count glyphs crowd the active and done numerals; and
- the redundant Activity-tab tooltip opens over the Subagents heading.

This is a presentation-only correction. Activity state, counts, navigation,
provider identity, cancellation authority, and public contracts remain
unchanged.

## Approved Design

### Compact Activity dock

Render exactly one provider icon followed by textual counts:

```text
[provider] Active 4 · Done 2
```

The counts use distinct text tones, tabular numerals, explicit spacing, and a
separator. They do not render loader/check-circle glyphs. The expanded dock
keeps its existing single provider icon and text-first section layout.

### Activity panel tab

Remove the tooltip whose content duplicates the already-visible `Activity`
tab label. The tab remains a normal accessible button with its visible label,
Bot icon, active styling, focus ring, activation behavior, and context-menu
behavior. Removing the tooltip prevents any popup from covering the Activity
panel heading while hovering or focusing the tab.

## Alternatives Considered

1. **Recommended and approved: plain textual counts plus no redundant tab
   tooltip.** This removes both collision classes rather than tuning offsets.
2. Increase spacing around the two count glyphs. This retains icon clutter and
   can regress again under zoom or font rasterization.
3. Widen the dock and move the tooltip above the tab. This spends scarce panel
   width and still shows redundant hover content.

## Constraints

- Keep one provider icon in the collapsed dock and one provider icon per
  roster row.
- Preserve exact active/done values, saturation, stale-state accessibility,
  keyboard navigation, and focus behavior.
- Do not change Activity contracts, RPC, persistence, client-runtime state, or
  cancellation logic.
- Do not add hover-only information needed to understand the UI.

## Verification

### Automated

- Add real-DOM assertions that compact counts contain `Active`, `Done`, and a
  separator, and contain no loader/check status glyphs.
- Add a RightPanelTabs regression proving Activity renders without a tooltip
  popup while retaining its visible label, icon, and activation.
- Run the focused Activity dock/right-panel tests, web typecheck, `vp check`,
  and workspace typecheck.

### Packaged visual review

Build and launch the exact release bundle as one process. Capture and inspect
original-resolution and zoomed crops for:

- collapsed dock at normal and narrow widths;
- Activity tab at rest, hover, and keyboard focus;
- the Subagents heading while the Activity tab is hovered/focused;
- normal and narrow Activity roster geometry.

The review must explicitly check count/icon collisions, tooltip overlays,
clipping, focus-ring completeness, status/action collisions, and raw provider
identifiers before declaring the UI clean.

## Residual Boundaries

This correction does not change the existing live-Claude authentication
limitation. Automated public-RPC tests remain the Claude cancellation proof
when the packaged provider is not authenticated.
