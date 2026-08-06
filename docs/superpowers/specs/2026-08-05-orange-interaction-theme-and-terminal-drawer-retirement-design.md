# Orange Interaction Theme and Terminal Drawer Retirement Design

**Status:** Approved

**Date:** 2026-08-05

## Summary

BibCode will adopt the vintage orange used by the deployed marketing site as its application-wide interaction accent, retire the obsolete bottom terminal drawer, route terminal keyboard actions into the center-panel model, and make center-pane header actions responsive at narrow split widths.

The deployed site's exact interaction orange is `#d8610e`. BibCode will use that same value in light and dark mode. Solid selected controls will use white foreground text, as approved in the visual review. Informational blue, link blue, provider colors, syntax colors, terminal ANSI colors, and semantic success/warning/error colors remain distinct.

The implementation is intentionally surgical: remove drawer-only behavior and state while preserving the terminal renderer, transport, session attachment, terminal links, and right-panel terminal capabilities needed by the remaining terminal surfaces.

## Goals

- Replace the current blue interaction and selection accent with `#d8610e` in light and dark mode.
- Keep semantic and domain-specific blues blue.
- Remove the bottom terminal drawer and its top-toolbar toggle completely.
- Remove drawer-only rendering, layout state, persistence, mounting, and shortcut behavior.
- Preserve center and right-panel terminal behavior and lifecycle correctness.
- Repurpose `Cmd/Ctrl+J` to create a terminal tab in the focused center group.
- Make terminal new, split, and close shortcuts operate predictably according to terminal focus ownership.
- Prevent focused center-pane header actions from clipping or overlapping at narrow split widths.
- Preserve keyboard access, focus behavior, migration compatibility, and rollback safety.

## Non-goals

- Changing the marketing website.
- Recoloring informational messages, links, providers, files, syntax, terminal ANSI output, warnings, errors, or success states to orange.
- Changing the terminal RPC protocol or introducing a new terminal runtime.
- Redesigning right-panel layout or removing right-panel terminal-internal splitting.
- Rewriting the terminal renderer from scratch.
- Bulk-terminating server terminal sessions during client migration.

## Approved Product Decisions

1. `#d8610e` is the interaction accent in both themes.
2. Solid orange selected controls use white text in both themes.
3. Blue is retained for semantic information, links, and domain-specific colors.
4. The bottom terminal drawer and its toolbar toggle are removed, not merely hidden.
5. `Cmd/Ctrl+J` creates and focuses a terminal tab in the focused center group.
6. Center-terminal split shortcuts create terminal surfaces in center layout splits.
7. Existing right-panel terminal shortcut behavior remains intact.
8. The center-pane `+` action remains visible at every supported width.
9. Secondary center-pane actions collapse into a `...` overflow menu when the pane is narrow.

## Theme and Color Semantics

### Shared tokens

The application theme remains token-driven. Both the light and dark theme definitions set:

- `--primary: #d8610e`
- `--primary-foreground: #ffffff`
- `--ring: #d8610e`

Any theme aliases used by shared controls, sidebars, or focus treatments must resolve to the same interaction values. Components already expressed through `bg-primary`, `text-primary`, `border-primary`, or `ring-ring` should inherit the change without local overrides.

### Semantic blue boundary

Primary interaction color and semantic information must not share a token. The theme will expose explicit link/information tokens and Tailwind mappings where required. Existing `--info` colors remain blue. Links currently styled through the primary token must migrate to the link token so changing the interaction accent does not recolor them.

Provider branding, file/status colors, diff colors, syntax highlighting, preview cursor identities, terminal palettes, and success/warning/error colors remain owned by their existing semantic tokens or domain models.

### Explicit blue audit

The implementation will audit hard-coded blue utilities and color literals. A blue value changes only when its role is interactive selection or focus, such as:

- checked switches and toggles;
- primary buttons and progress affordances;
- selected tabs, rows, cards, or picker entries;
- active drag/drop targets;
- active outlines, borders, and focus rings.

A blanket replacement of every blue literal is prohibited.

### Contrast decision

The approved white-on-orange foreground has approximately 3.73:1 contrast against `#d8610e`, below WCAG AA for small normal text. This is an explicit visual product decision. To reduce reliance on color alone:

- selected controls retain shape, position, icons, checks, borders, or other non-color cues;
- keyboard focus uses a visible ring in addition to the fill;
- disabled and selected states remain structurally distinguishable;
- accessible names and state attributes remain intact.

## Bottom Terminal Drawer Retirement

### Removed UI

Remove:

- the persistent bottom drawer mount;
- its resize handle and height calculations;
- hidden mounts retained across thread changes;
- the bottom-panel icon from the top toolbar;
- drawer open/closed rendering branches;
- drawer-specific empty states and action chrome.

The remaining toolbar control is the right-panel control. `PanelLayoutControls` should be simplified or renamed so its public API no longer contains terminal-drawer props or callbacks.

### Removed state and persistence

The drawer's Zustand state is no longer authoritative for any supported surface. Remove its open state, height, terminal groups, active drawer terminal, suppression list, reconciliation actions, orphan cleanup, and associated subscriptions.

Delete the legacy `bibcode:terminal-state:v1` local-storage entry through a small versioned client migration. The migration discards only drawer presentation state. It must not issue terminal-close RPCs because a known server terminal may belong to a valid center or right-panel surface.

Remove drawer-state dependencies from:

- chat rendering and shortcut routing;
- command-palette shortcut context;
- global chat-route shortcut context;
- sidebar shortcut hints;
- thread archive/delete cleanup;
- tests and fixtures that exist only for the drawer store.

### Preserved terminal infrastructure

Keep:

- terminal open/write/close RPCs;
- session attachment and transcript handling;
- terminal input scheduling;
- xterm rendering and resizing;
- terminal links and context capture;
- provider-terminal activity;
- center surface lifecycle;
- right-panel terminal grouping and splitting.

The reusable `ThreadTerminalDrawer` component should become a panel-oriented renderer, for example `ThreadTerminalPanel`. Remove drawer-only height, visibility, resize, and ownership branches while preserving one-terminal center hosting and multi-terminal right-panel hosting. This is a refactor of the existing renderer, not a replacement.

## Terminal Focus Ownership and Commands

### Explicit ownership

The shared terminal renderer must receive an explicit owner:

- `center-panel`
- `right-panel`

The obsolete `drawer` owner is removed. Focus detection must return the actual surface owner so shortcuts never fall through from a center terminal into right-panel or legacy drawer behavior.

The `terminalFocus` shortcut context remains true for either supported owner. If the `terminalOpen` context remains public for user-defined `when` clauses, redefine it as "the active thread has at least one center or right-panel terminal surface," derived from the supported surface stores rather than drawer state.

### `Cmd/Ctrl+J` migration

Replace the obsolete `terminal.toggle` command with `terminal.newCenter`.

- The default `mod+j` binding points to `terminal.newCenter`.
- Existing persisted custom bindings for `terminal.toggle` are normalized to `terminal.newCenter` before current-schema validation.
- The migration preserves the user's shortcut, modifiers, replacement behavior, and `when` clause.
- The keybinding settings UI labels the action as creating a center terminal, never as toggling a drawer.
- After normalization, the current command catalog and generated settings omit `terminal.toggle`.

### Center terminal behavior

For the focused center group:

- `terminal.newCenter` creates and focuses a terminal tab.
- `terminal.new` creates and focuses another terminal tab when a center terminal owns focus.
- `terminal.split` creates a new terminal surface in a right-hand center split.
- `terminal.splitVertical` creates a new terminal surface in a downward center split.
- `terminal.close` closes the active center terminal surface and its backend session.

The split commands create a new terminal surface; they do not move the currently focused terminal. Context-menu "Move Tab to Split" remains the action for relocating an existing surface.

### Right-panel behavior

When a right-panel terminal owns focus, `terminal.new`, `terminal.split`, `terminal.splitVertical`, and `terminal.close` retain their existing right-panel behavior. `terminal.newCenter` always targets the focused center group because it is the global replacement for drawer access.

### Limits, failures, and focus

Before spawning a split terminal, validate:

- the four-pane center-layout limit;
- minimum geometry for the requested direction;
- presence of a valid host thread and terminal launch context;
- legality of the center-store transition.

If validation fails, show a concise notice and create no terminal session.

If session creation succeeds but the center-store update fails, close the newly created session and restore the previous layout. The action must not leave a hidden session or partial surface.

Creation and splitting focus the new terminal. Closing a terminal activates the group's next surviving tab. If closing empties a split group, normal center-layout collapse rules restore focus to the surviving group.

## Responsive Center-Pane Header Actions

### Behavior

The focused center-pane header responds to the pane's own width rather than the application window width.

At supported widths:

- the New Panel `+` remains visible;
- pane actions remain visible when applicable;
- the tab strip shrinks and truncates first;
- visible action buttons never shrink, overlap, or clip;
- the action area keeps a consistent right inset;
- the top-right pane continues reserving native title-bar controls.

At wide widths, render the existing full project-action and editor controls. At narrow widths, replace secondary visible controls with one accessible `...` overflow menu. The menu exposes the same supported project actions and editor actions without duplicating business logic.

This adaptive behavior applies to every focused center pane, not only terminal tabs, because the clipping risk is created by pane geometry rather than surface kind.

### Architecture

Use a named CSS size container on the center-pane header so responsive behavior follows local pane width. Derive one action model and render it in expanded or compact presentation. Do not mount duplicate stateful controls merely to hide one copy with CSS.

Lifecycle-only behavior, such as hidden Git synchronization, remains mounted independently of the visible expanded/compact trigger. Dialog ownership and action callbacks remain stable while presentation switches.

### Accessibility

- The overflow trigger has an accessible name and accurate expanded state.
- Menu items retain keyboard navigation, focus restoration, disabled reasons, and tooltips where applicable.
- Tab truncation preserves the full accessible tab name.
- Focus rings use the orange interaction ring in both themes.

## State and Data Flow

### Create center terminal

1. Resolve the active thread, launch context, and focused center group.
2. Validate that the group can accept a terminal tab.
3. Allocate and open a terminal session.
4. Add a terminal surface to the focused group.
5. Activate the surface and request terminal focus.
6. If surface insertion fails, close the newly opened session.

### Create center terminal split

1. Resolve the active center group and requested split direction.
2. Validate pane count and measured group geometry before spawning.
3. Open a terminal session.
4. Atomically add the terminal surface and create the adjacent split group.
5. Activate the new group and request terminal focus.
6. On transition failure, restore the previous center state and close the session.

### Close center terminal

1. Remove the surface through the center-store lifecycle action.
2. Collapse an empty split group if required.
3. Activate the next valid surface/group.
4. Close the terminal session once the UI transition is committed.
5. Preserve the existing idempotent close and late-session-exit safeguards.

## Error Handling

- Missing project/thread/cwd context produces a user-visible notice and no mutation.
- Split-limit or geometry rejection produces a notice and no terminal spawn.
- Terminal-open failures leave the center layout unchanged.
- Center-store failures after terminal open trigger compensating terminal close.
- Close failures follow existing terminal error reporting while the UI remains in a consistent closed state.
- Keybinding migration ignores malformed legacy entries using the existing validation/reporting path; valid unrelated bindings remain intact.
- Responsive presentation changes never rerun project scripts, reopen dialogs, or duplicate synchronization effects.

## Testing and Verification

### Theme

- Assert light and dark `primary` and `ring` values are exactly `#d8610e`.
- Assert solid primary/selected foreground is white in both themes.
- Cover representative buttons, switches, selected tabs/rows, drag targets, and focus rings.
- Assert informational badges and links remain blue.
- Assert provider, syntax, diff, and terminal color systems are unchanged.

### Drawer removal

- Assert the bottom drawer is not rendered.
- Assert the top-toolbar bottom-panel toggle is absent.
- Remove drawer-store tests and add a migration test that deletes `bibcode:terminal-state:v1` without terminal-close calls.
- Assert chat, sidebar, route, command palette, and thread cleanup no longer subscribe to drawer state.

### Commands and lifecycle

- Test legacy `terminal.toggle` keybinding normalization.
- Test default and custom `terminal.newCenter` resolution.
- Test center versus right-panel focus ownership.
- Test center new, split right, split down, and close behavior.
- Test four-pane and minimum-geometry rejection before spawn.
- Test open failure and layout-failure compensation.
- Test focus after create, split, close, and split-group collapse.
- Retain right-panel terminal new/split/close regression coverage.

### Responsive toolbar

- Test expanded actions at wide local pane width.
- Test `+` plus overflow presentation at narrow width.
- Test extreme supported width without clipping or overlap.
- Test menu keyboard access, disabled states, dialog continuity, and focus restoration.
- Test native-titlebar reservation in the top-right pane.
- Test lifecycle-only hidden controls remain mounted once.

### Required commands and desktop verification

During implementation, run focused tests first, then:

- `vp test`
- `vp check`
- `vp run typecheck`

Build and launch the desktop application. Use Codex computer use to verify:

- orange controls in light and dark mode;
- semantic blue remains blue;
- no bottom drawer or drawer toggle;
- `Cmd/Ctrl+J` creates a center terminal;
- center terminal new/split/close shortcuts;
- right-panel terminal regression behavior;
- full and compact header actions across pane widths;
- no toolbar clipping at the width shown in the reported screenshot.

## Acceptance Criteria

1. Light and dark themes use `#d8610e` for all interaction/selection states in scope.
2. Solid orange selected controls use white text.
3. Informational, link, provider, syntax, diff, terminal, success, warning, and error colors retain their semantics.
4. No bottom terminal drawer can render, and no top-toolbar button references it.
5. No drawer-only Zustand state or persisted presentation state remains active.
6. Center and right-panel terminals continue attaching, rendering, focusing, and closing correctly.
7. `Cmd/Ctrl+J` creates a center terminal and legacy custom bindings migrate.
8. Center terminal new/split/close shortcuts follow the approved center layout behavior.
9. Rejected or failed split creation leaves no hidden terminal session.
10. Narrow center panes show `+` and a usable overflow menu without overlap or clipping.
11. Wide panes retain the full action presentation.
12. Required tests, checks, type checking, desktop build, and Codex computer-use verification pass.
