# Center Panel Focus Color Design

**Date:** 2026-08-08

**Status:** Approved.

## Summary

Remove the orange visual emphasis from the focused center pane. Focused and
unfocused panes will use the same neutral panel framing in both light and dark
themes.

## Scope

The change is owned by `apps/web`, whose `CenterPanelSplitLayout` renders the
shared center-pane chrome in both browser and Tauri desktop modes. The focused
pane will retain its `data-focused` state, focused action rail, pointer and
keyboard focus handling, terminal focus eligibility, layout persistence, and
all other behavior. Only the focus-dependent pane ring color styling changes.

No contracts, persistence formats, RPC flows, desktop bridge operations,
provider behavior, or Rust code change.

## Implementation

Remove the `data-[focused=true]` ring utilities from each center-pane region.
Preserve the keyboard `focus-visible` ring geometry (`after:ring-2`) while
changing its color from the orange global ring token to `after:ring-border`.
This user-approved amendment keeps the accessibility affordance without an
orange focused-pane perimeter.

Do not change the global `--ring` token: it intentionally supplies the orange
interaction color to controls throughout the application. Do not add a new
pane-specific color token, because the desired focused appearance is exactly
the existing unfocused appearance.

## Verification

- Add a focused component regression test proving focused and unfocused pane
  regions have identical framing classes and no focus-state ring utility while
  focus state and focused actions remain intact.
- Run the focused center-panel test, `vp check`, and `vp run typecheck`.
- Build and launch the Tauri desktop application from this worktree.
- In a split-pane desktop workspace, capture and inspect light- and dark-mode
  screenshots, confirming the focused pane has no orange frame and matches the
  unfocused pane color in both themes.

## Alternatives Rejected

- Changing the global ring token would alter focus styling across unrelated
  controls.
- Removing keyboard focus-visible geometry would reduce the accessibility
  affordance; the approved neutral `after:ring-border` color preserves it.
- Adding a new pane token would duplicate an appearance already provided by
  the unfocused state.
