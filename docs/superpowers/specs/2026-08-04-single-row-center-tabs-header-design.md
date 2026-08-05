# Single-Row Center Tabs Header Design

Date: 2026-08-04
Status: Approved

## Summary

Replace the chat workspace's stacked thread-title header and center-panel tab strip with one compact top bar. The left side becomes a horizontally scrollable tab rail. The existing project and panel actions remain pinned on the right and never overlap the tabs.

Remove the visible thread title from this area. Every center tab instead describes the surface it contains: before its first turn the host chat follows the selectable AI provider, after start it remains labeled from its bound provider, added chats use their provider labels, and terminals use their terminal titles.

## Current Layout

The chat workspace currently renders two rows:

1. A workspace top bar containing the thread title and project actions.
2. A separate center-panel tab strip containing `Main`, added AI chats, and terminals.

This duplicates navigation context, consumes vertical space, and separates center-panel navigation from the controls that create and manage those panels. The tab strip can already contain multiple surfaces, so merging the rows must preserve overflow navigation without allowing tabs to cover the fixed action controls.

## Goals

1. Render center-panel tabs and existing top-bar actions on one line.
2. Remove the visible thread-title block from the chat workspace header.
3. Replace the host tab's `Main` label with the current provider's display name.
4. Keep every existing action visible and operable when many tabs are open.
5. Make crowded tabs horizontally navigable with pointer, trackpad, mouse wheel, and keyboard access.
6. Preserve existing center-panel activation and closing behavior.

## Non-Goals

- Do not change how center-panel surfaces are created, activated, persisted, or closed.
- Do not change the center-panel store schema or persist a label on the host surface.
- Do not rename threads or remove thread titles from the sidebar and other navigation surfaces.
- Do not redesign the project action menus, Open picker, or panel-layout controls.
- Do not introduce tab wrapping. The rail's compact overflow navigator is part of the primary tab navigation, not a second tab row.

## Layout

`ChatView` continues to own the workspace top bar. Inside it, the center tabs and actions become siblings:

- `CenterPanelTabs` occupies the flexible left region with `min-width: 0` so it can shrink and scroll.
- The existing header actions occupy a non-shrinking right region.
- The existing desktop title-bar layout controls retain reserved space when they are positioned over the chat top bar.
- The top bar owns the single bottom border. The tabs no longer render a second bordered row.

The action region always wins width. An isolated, paint-clipped rail boundary ends before the opaque, non-shrinking action cluster. When space becomes constrained, only the tab viewport shrinks; tabs cannot paint over, push, cover, or shrink action buttons. A subtle trailing fade and an overflow-only navigator indicate that additional tabs continue beyond the visible edge.

Closing all center surfaces leaves the left region empty while keeping the action controls available. It does not restore the removed thread title.

## Tab Naming

The host chat surface remains the store's schema-only `chat-host` entry. Its visible label is derived at render time:

1. Before the first turn, use the selected provider instance's non-empty `displayName` when available.
2. After the thread starts, prefer the session-bound provider instance, falling back to the thread's bound model-selection instance.
3. Fall back to the corresponding provider driver label, such as `Codex` or `Claude`.

Before start, the label reacts to the existing provider selection state without changing persisted center-panel state. Once a chat starts, its provider/model family is locked: stale composer selection must not relabel the host, its model picker must not offer cross-provider models, and another provider appears only in a separately created chat tab.

Other surfaces keep their existing naming sources:

- Added AI chat: the surface's `providerLabel`, falling back to `Chat` only for legacy or incomplete state.
- Terminal: the explicit surface label, then a live terminal label, then the generated terminal fallback.

No center tab uses `Main`.

## Component Boundaries

Refactor the current title-and-actions `ChatHeader` into an actions-focused component, named `ChatHeaderActions`. It remains responsible for:

- the panel creation menu;
- project scripts;
- the local Open picker;
- the mounted hidden Git actions integration;
- reserving room for desktop layout controls when required.

`CenterPanelTabs` remains responsible for tab presentation and interactions. It gains an explicit host label input rather than importing provider state or changing `CenterSurface`. This keeps provider selection in `ChatView`, where it is already resolved, and keeps the tab component reusable and deterministic.

`ChatView` composes both components inside the existing workspace header and passes the derived host label to `CenterPanelTabs`. It removes the visible thread-title prop and the standalone tab-strip placement below the header.

## Overflow and Navigation

The tab list is a single-line horizontal scroll rail inside the flexible region:

- Tabs retain bounded minimum and maximum widths and truncate long labels.
- Trackpad and native horizontal-wheel input scroll the rail.
- Vertical mouse-wheel input over an overflowing rail is translated to horizontal movement so a conventional mouse can reach hidden tabs without an extra modifier.
- Only while overflow exists, compact Previous tabs, Next tabs, and All tabs controls appear inside the rail boundary. Page controls move by most of a viewport and All tabs lists every chat and terminal for a direct accessible jump.
- When the active surface changes, its tab scrolls into the nearest visible position.
- Keyboard users can focus tab buttons and close buttons through the existing controls; horizontal arrow navigation follows the tab order when focus is within the rail.
- The trailing fade is visual only and does not intercept pointer input.

The action region is outside the scroll container and uses non-shrinking layout. Scrolling the tabs therefore cannot move or cover the panel menu, scripts, Open picker, or layout buttons.

## Preserved Interactions

The refactor preserves:

- click activation;
- close buttons;
- middle-click close;
- the native tab context menu and all of its close commands;
- automatic reveal of the active tab;
- host-surface close behavior;
- panel and transcript state retention when switching surfaces.

## Fallbacks and Reliability

Provider status can be temporarily absent while an environment connects or refreshes. The host label must remain stable and meaningful by falling back to the resolved pre-start selected driver or post-start bound driver. It must never show an empty string, follow a stale cross-provider composer selection after start, or revert to `Main`.

Overflow handlers perform no state mutation beyond scrolling. They must tolerate a missing viewport ref and non-overflowing content without throwing or preventing unrelated page scrolling. Vertical-wheel translation applies only when horizontal overflow exists and the event has a meaningful vertical delta.

## Accessibility

- The workspace header retains an accessible label even though the thread title is no longer visible inside it.
- Each tab exposes its full, untruncated surface label through the existing tooltip and accessible button content.
- Active state remains distinguishable without relying only on hover.
- Close buttons retain surface-specific accessible labels.
- Keyboard focus remains visible throughout the tab rail and action region.
- The scroll fade is ignored by assistive technology.

## Testing

### Component tests

- `CenterPanelTabs` renders the supplied provider name for the host surface and never renders `Main`.
- Added chat and terminal naming fallbacks remain unchanged.
- Changing the host label rerenders the provider name without mutating surface state.
- Activating a hidden tab scrolls it into view.
- Vertical wheel input advances an overflowing horizontal rail and does nothing when the rail is not overflowing.
- The explicit navigator is hidden without overflow; its page controls scroll the viewport and its All tabs menu activates and reveals any listed surface.
- Horizontal arrow keys move focus through the tab order and reveal the newly focused tab.
- Click, close, middle-click, and context-menu behavior remain covered.
- `ChatHeaderActions` renders all applicable actions without rendering the thread title.

### Integration tests

- `ChatView` renders a single top-bar row with the tab rail before the action region.
- The old standalone center-panel tab strip is absent.
- Pre-start provider selection supplies the current display name; a started thread's bound session/model provider wins over stale composer selection.
- Empty center-surface state keeps the actions available with an empty left region.
- Right-panel open and closed states reserve the correct desktop layout-control space.

### Visual verification

After implementation and automated checks, use the Codex `computer-use:computer-use` skill against the running BiBCode desktop app. Verify the UI at wide and constrained workspace widths with enough AI and terminal panels to overflow. Confirm that every accepted design change is present:

1. The thread title is absent from the top bar.
2. Tabs and actions share one row.
3. The host tab displays the current provider.
4. Hidden tabs are reachable and the active tab reveals itself.
5. Tabs never overlap or displace the existing action and layout controls.
6. Long provider and terminal names truncate cleanly and expose their full labels.
7. A started host remains labeled from its bound provider; searching another provider in its picker yields no cross-provider model and cannot relabel it. Other providers remain separate chat tabs.
8. The overflow-only Previous, Next, and All tabs controls reach hidden tabs while staying inside the rail boundary.
9. Click activation, wheel/trackpad navigation, close controls, and the pinned action controls remain operable.

Capture fresh accessibility state and screenshots during this verification. Treat any missing accepted change, visual overlap, unreachable tab, or broken interaction as a failed verification that must be fixed before completion.

Run the focused web tests for the changed components, followed by `vp check` and `vp run typecheck`, before the Computer Use verification.

## Acceptance Criteria

- The chat workspace header uses one row instead of separate title and tab rows.
- No visible thread-title block remains in that header.
- No center tab is labeled `Main`.
- The host chat tab follows selectable provider state before start and the bound session/model provider after start.
- Added AI and terminal tabs retain content-specific labels.
- Multiple tabs remain reachable through wheel/trackpad, keyboard, page buttons, and the All tabs menu at constrained widths.
- Existing top-bar actions remain fixed, visible, and operable without tab overlap.
- Existing center-panel interactions continue to work.
- Focused tests, `vp check`, and `vp run typecheck` pass.
- Codex Computer Use verification confirms every accepted layout, naming, overflow, and interaction change in the running desktop UI.
