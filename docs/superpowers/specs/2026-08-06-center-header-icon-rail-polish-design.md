# Center Header Icon Rail Polish Design

**Date:** 2026-08-06

**Status:** Approved visual direction; ready for implementation planning after written-spec review.

## Goal

Replace the visually mixed center-header icon cluster with the user-selected **Option 2: uniform outlined controls** while preserving every existing action, shortcut, responsive rule, and accessibility contract.

## Problem

When the center tab rail overflows in a compact pane, the header places bare navigation controls beside separately outlined workspace-action buttons. The controls differ in size, border treatment, spacing, and visual weight even though they form one local toolbar. The resulting cluster looks accidental and crowded.

The purple pointer glow visible over the tab close button in the reference screenshot is the Codex Computer Use cursor indicator, not application UI, and is outside this change.

## Scope

This change covers only the icon controls to the right of the center tab rail:

- Previous tabs;
- Next tabs;
- All tabs;
- New panel;
- compact More workspace actions.

It does not redesign tabs, the tab close button, expanded text/project actions, split-pane behavior, terminal content, right-panel terminal controls, or native titlebar controls.

## Selected Visual Treatment

All covered controls use one shared center-header icon-button presentation:

- outlined secondary treatment in light and dark themes;
- 28px square desktop target using the existing design-system size scale;
- matching border, background, radius, shadow, and icon opacity;
- 16px icon geometry with the existing Lucide stroke language;
- 4px spacing between adjacent controls;
- one subtle boundary divider between the scrollable tab rail and the icon rail;
- existing orange focus-ring token;
- existing 8px right inset outside the focused action group.

Hover, pressed, disabled, and focus-visible states come from the shared Button design system rather than locally duplicated class lists.

## Architecture

Introduce one small shared `CenterHeaderIconButton` presentation component backed by the existing `Button` primitive. It fixes the header-specific size and outline variant and adds a stable semantic marker for focused regression tests.

Use this component in:

- `CenterPanelTabs` for Previous, Next, and All tabs;
- `ChatHeaderPanelMenu` for New panel;
- `ChatHeaderActions` for compact More workspace actions.

The overflow navigator remains owned by `CenterPanelTabs`; workspace actions remain owned by `ChatHeaderActions`. Only their shared presentation is extracted. No state, event handler, menu ownership, or action model moves between components.

The overflow navigator and compact workspace action group both use a 4px internal gap. The navigator keeps a single left boundary divider and enough inline padding to maintain the same 4px rhythm where the two ownership regions meet. Expanded project/editor actions retain their established spacing and presentation.

## Behavior and Accessibility

The change must preserve:

- all accessible labels and tooltips;
- tab scrolling and page-navigation behavior;
- the All tabs menu;
- the New panel menu;
- the compact workspace-action menu;
- keyboard navigation and focus restoration;
- disabled states and callbacks;
- local-pane density switching;
- New panel visibility at every supported pane width;
- native titlebar reservation and 8px right inset;
- no overlap or clipping at narrow widths.

The shared component must render a native button through the existing Button primitive and must not add state or listeners.

## Testing

Use test-driven development.

Automated coverage must prove:

1. all five covered controls render through the shared outlined header-control contract;
2. overflow navigation keeps its labels and callbacks;
3. New panel and compact More workspace actions keep their menus and callbacks;
4. compact spacing is uniform while expanded action spacing remains unchanged;
5. the existing titlebar reservation and 8px right inset remain intact;
6. narrow headers keep controls visible without overlap or horizontal overflow.

Run focused center-tabs/header-action tests, then the full repository test suite, `vp check`, `vp run typecheck`, `git diff --check`, the desktop release build, and exact-bundle Computer Use verification in both a compact overflow state and the normal wide state.

## Out of Scope

- collapsing navigation into a single menu;
- changing which controls appear at a given density;
- changing the tab close affordance;
- changing action icons or labels;
- changing terminal lifecycle behavior;
- changing global Button styles;
- adding dependencies.

## Acceptance Criteria

The work is complete when the compact center header reads as one consistent outlined icon rail, every covered control has matching geometry and interaction chrome, the single divider and 8px right inset remain, no toolbar action changes behavior, the exact packaged app matches Option 2, all automated gates pass, and the final review has no unresolved findings.
