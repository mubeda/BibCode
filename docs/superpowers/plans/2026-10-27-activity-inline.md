# Plan: inline Activity panel (#188) and macOS x64 terminal dock (#192)

The decisions behind this plan, and its evidence, are in
[the design](../specs/2026-10-27-activity-inline-design.md).

Branch: `claude/b3-activity-inline`, from `origin/develop` at `27702287cc`.

## Acceptance criteria

- **#188-A (blocking):** In the packaged app, clicking the dock opens an inline
  panel inside the same chat or terminal pane, and the right panel's DOM and
  store state do not change.
- **#188-B:** Collapse and expand work by mouse, Enter, and Space. The dock
  exposes `aria-expanded` and `aria-controls`. Escape in the panel collapses it
  and returns focus to the dock.
- **#188-C:** Roster and record detail behave as they do today: section tabs,
  Back, Stop, Retry, and removal notices.
- **#188-D:** It works in chat and terminal panes. Two split panes have
  independent panels.
- **#188-E:** The `activity` right-panel surface is gone. Persisted state that
  points at it migrates closed.
- **#188-F:** Each pane's expanded state and route survive a reload.
- **#192 (blocking):** On macOS x64, the live Codex terminal dock appears. The
  root cause is Codex observer preparation running past its 350 ms budget,
  which passes through silently (design section 1). The fix is in
  `apps/server`, so it **needs an owner decision before phase 2**.

## Changes, in commit order

Every commit typechecks on its own. The right-panel surface is removed (step 4)
only after nothing references it (steps 2 and 3).

### 1. Persisted pane state

- Add `components/activity/activityPaneState.ts`. It holds the route
  normalizers moved from `rightPanelStore.ts`.
- In `centerPanelStore.ts`, add the `activityPanes` root field and its two
  actions. Prune entries on surface and thread removal. Bump the storage
  version from 3 to 4, with a migration. Add a `merge` that normalizes
  `activityPanes` on every hydration, which the store lacks today.
- Tests in `centerPanelStore.test.ts`:
  - migrating version 3 to 4;
  - a same-version hydration with a corrupt entry, which `merge` sanitizes;
  - malformed entries;
  - pruning on each removal path;
  - a stale navigation being a no-op;
  - nothing persisted for default panes.

### 2. `ActivityPane` and the dock as a toggle

- Move the bindings and `useBoundedActivityQuery` out of `ChatView.tsx` into
  `components/activity/ActivityPaneBinding.tsx`.
- Add `ActivityPane.tsx`: a card holding the dock header and the
  `ActivityPanel` body. It owns the expand, collapse, focus, and Escape
  behavior, and reads and writes `centerPanelStore`.
- `ActivityDock.tsx`:
  - Becomes a toggle with `aria-expanded`, `aria-controls`, and a chevron.
  - The label becomes `Activity: …`.
  - `avoidRightPanelSheet` is removed.
- `ActivityPanel.tsx`: the route type comes from `activityPaneState`, not
  `rightPanelStore`.
- `ProviderTerminalActivityDock.tsx`: renders `ActivityPane` for
  `terminal:<terminalId>`.
- Tests:
  - `ActivityDock.test.tsx`: the toggle, its name, and its ARIA attributes.
  - `ActivityPanel.test.tsx`: the route-type import changes. Behavior stays
    as it is today.
  - New `ActivityPane.test.tsx`:
    - expand, collapse, Escape, and focus;
    - the remembered route on re-expand;
    - no focus taken after a reload;
    - a collapsed body mounts no queries;
    - an expanded pane is kept at zero counts.
  - `ProviderTerminalActivityDock.test.tsx`: replace the "opens the exact
    persisted terminal scope" case with "expands inline; the right panel is
    untouched".

### 3. ChatView and terminal mounts (needs the ChatView ownership grant)

- `ChatView.tsx`:
  - Delete the right-panel activity plumbing (design section 4, item 1).
  - Mount `ActivityPane` in the messages wrapper with the thread scope and the
    pane key (`chat:host`, or `chat:<threadId>` for panels).
  - Gate the host on its surface being visible, which replaces
    `siblingChatOwnsCenter`.
  - Add `ChatViewPanelProps.activityPaneHostRef`, passed from
    `LiveCenterPanelWorkspace` at about line 1422. This keys panel chats
    under the host thread.
  - Leave follow and scroll code untouched.
- `ThreadTerminalPanel.tsx:2399`: the host stays. It passes the pane key
  through `ProviderTerminalActivityDock`.
- Tests:
  - `ChatView.test.tsx`, rewritten for the inline panel:
    - 1441 (a late cancellation after the target changes);
    - 1821 (terminal bindings are read-only);
    - 1860 (settingsUpdated removes and restores the panel);
    - 2266 (the idle button);
    - 2735 (stale activity across a reconnect; the Back half moves to the
      inline panel);
    - 2782, 2846, 3117 (query stability and revalidation on re-expand);
    - 3175 and 3217 (a panel chat gets its own inline panel; re-expanding
      focuses its section);
    - 4366 (launches still work after activity is downgraded).
  - `ChatView.test.tsx`, deleted because the behavior no longer exists:
    - 1905, 1937, 1979 (the persisted right-panel surface and the
      disabled-setting close effects);
    - 2706 (compact dock beside the right-panel sheet);
    - 3252 (the panel chat's compact sheet);
    - 3334 and 3444 (handing off between host and sibling, and the suppressed
      host);
    - 3554 (the pinned terminal scope);
    - 3603 (closing only Activity from a panel).
  - `ChatView.test.tsx`, added:
    - two split chat panes have independent panels;
    - a focused sibling no longer hides the host dock in a split;
    - expanding the panel does not change `rightPanelStore` state or the
      timeline scroller's `scrollTop`.
  - `ChatView.hooks.test.tsx:~3030`: drop the `openActivity` setup.
  - `ActivitySurfaces.test.tsx`: drop the `RightPanelSheet` wrapper. Cover the
    panel inside the pane card.

### 4. Right-panel surface removal and migration

- `rightPanelStore.ts`:
  - Remove the kind, its type, actions, focus requests, and selector.
  - Bump the storage version from 10 to 11.
  - When the persisted active surface was `activity`, set `isOpen = false` and
    make the first remaining surface active.
- `RightPanelTabs.tsx`: remove the `activity` cases.
- Tests in `rightPanelStore.test.ts`:
  - Delete the activity-action cases (lines 122–368).
  - Rewrite line 915 as migration cases: Activity was the only surface;
    Activity was active among others; Activity was inactive among others.

### 5. Packaged end-to-end (`chat-activity-panel.e2e.ts`)

The complete-caller proof for #188-A through #188-F.

- **Remove:**
  - the "Toggle right panel" open and close steps (lines 654–656, 895–906,
    925–929);
  - the sheet assertions at 960 px;
  - the `sheet` geometry field.
- **Add:**
  - The dock toggles an inline `[data-activity-panel]` that sits inside the
    chat column. Its rectangle lies within `[data-chat-surface]`, below the
    dock, and outside the composer.
  - `aria-expanded` is true and then false.
  - Escape returns focus to the dock.
  - The right panel (`[data-right-panel]` or its equivalent) neither mounts
    nor changes.
  - The timeline scroller's `scrollTop` is unchanged across expand and
    collapse.
  - A reload keeps the panel expanded.
  - The terminal pane's dock expands its own panel inside the terminal host.
    The chat pane's panel state is independent of it.
- **Keep:** the existing terminal geometry and update assertions.
- **Update:** `desktopActivityAccessibleNames.dock` in
  `support/activity-events.ts`, which needs the ownership grant.

### 6. Documentation

- `docs/user/workspace-ui.md:1752-1770`: describe the inline panel, the
  toggle, Escape, per-pane memory, and that the right panel is no longer used.
- `docs/architecture/activity-observation.md:524`: "read-only terminal
  Activity panel".
- Runbooks:
  - `docs/testing/linux-desktop.md:758` and
    `docs/testing/cross-platform-validation.md:2970`: replace "reopening the
    global right panel after a sibling chat suppresses a previously active
    Activity surface" with the per-pane inline panel checks.
  - `cross-platform-validation.md:3110` stays as it is.
- If the #192 server change lands, document its new timeout warning in
  `docs/architecture/activity-observation.md` (the fallback paragraph at about
  line 485).

## #192 plan, once an owner is assigned

1. Log the preparation timeout. Add a supervisor `warn_once` in the `None`
   arm, plus a Codex stage and elapsed-time field. Add a Rust unit test with a
   helper slower than the budget, which asserts pass-through and the warning.
2. Raise the Codex budget: `CODEX_PREPARATION_BUDGET`, and a 1 s supervisor
   budget for `codex`. Update the Rust tests that assert
   `< CODEX_PREPARATION_BUDGET` if their meaning changes.
3. Run one batched `Packaged Desktop UI Smoke` dispatch on macOS x64 (not
   pushed by me). It proves the dock appears, or shows the logged stage and
   elapsed time if 1 s is still not enough. If it is not, the next step is
   detaching the probe and cache (design section 1, item 3), not another
   budget increase.

## Validation, in phase 2

- From `apps/web`: `vp test run --project unit` on the changed test files.
- `vp check --no-fmt`, plus `vp check <changed files>`.
- `vp run typecheck`.
- `vp test run scripts/bibcode-identity.test.ts`.
- Rust, only if the #192 server work is assigned here: `cargo fmt --all
  --check`, `cargo test -p bibcode-server --lib provider_terminal`, and
  `cargo clippy -p bibcode-server --all-targets -- -D warnings`.
- Packaged e2e on macOS arm64, locally: the chat-activity spec only.
- Reviews: `vercel-react-best-practices` for the changed components and hooks;
  `UI.md` for the toggle, Escape, focus, overlay, and empty state.

## Skipped (ponytail)

- Resizing the panel and remembering its size.
- Animating expand and collapse.
- Moving the dock to a different position.
- Server-side changes for #192 (they need an owner).
- A Rosetta build: it cannot reproduce a slow arm64 `node` start.
