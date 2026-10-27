# Plan: inline Activity panel (#188) and macOS x64 terminal dock (#192), round 2

The decisions and evidence are in
[the design](../specs/2026-10-27-activity-inline-design.md).

Branch: `claude/b3-activity-inline`, from `origin/develop` at `27702287cc`.

## Acceptance criteria

- **#188-A (blocking):** In the packaged app, the dock expands an in-flow
  panel in the same chat pane (above the composer) or terminal pane (bottom
  slot). The right panel's DOM and store state do not change.
- **#188-B:** Collapse and expand work by mouse, Enter, and Space. The dock
  has `aria-expanded` and `aria-controls`. Escape collapses the panel and
  focuses the dock.
- **#188-C:** Roster and detail behave as they do today. Collapsing keeps the
  chat's reading position mid-history and keeps an at-end list at the end. A
  terminal's TUI redraws at its new size.
- **#188-D:** Chat and terminal panes, and narrow split panes, stay usable:
  the composer is visible, terminal rows remain, and the card stays within its
  pane.
- **#188-E:** The right-panel `activity` surface is gone. A version 10 right
  panel pointing at Activity hydrates closed.
- **#188-F:** Each pane's expanded state and route are restored at mount after
  a reload, for both pane kinds, without moving focus.
- **#192 (blocking):** The macOS x64 `chat-activity-panel` assertion passes in
  one batched CI push (the coordinator pushes it).

## Changes, in commit order

Every commit typechecks on its own.

### 1. Saved pane state (web)

- Add `components/activity/activityPaneState.ts`, holding the normalizers
  moved from `rightPanelStore.ts`.
- `centerPanelStore.ts`:
  - Add the `activityPanes` root map and its two actions.
  - Add `pruneActivityPanes`, run from `withUpdatedThread`,
    `replaceMainWithTerminal`, and `removeThread`.
  - Storage version 3 → 4, with a migration and a new `merge` sanitizer.
- `centerPanelStore.test.ts`:
  - migrating version 3 to 4;
  - a same-version corrupt entry, cleaned by `merge`;
  - pruning on every removal path, including `replaceMainWithTerminal`;
  - a stale navigation being a no-op;
  - defaults not being written.

### 2. `ActivityPane`, the toggle, and focus gating (web)

- Move `useBoundedActivityQuery`, `ActivityStateTarget`, and both bindings
  into `components/activity/ActivityPaneBinding.tsx`.
- Add `ActivityPane.tsx`. It is the card (header dock and `ActivityPanel`
  body) and does the following:
  - reads its saved state synchronously at mount;
  - expands, collapses, and handles Escape and focus;
  - caps the body's height at the smaller of 22 rem and 45% of a measured
    pane;
  - marks its scroll content with `data-text-surface="card"`.
- `ActivityDock.tsx`:
  - becomes a toggle (`aria-expanded`, `aria-controls`, and a chevron);
  - its name becomes `Activity: …`;
  - drops `avoidRightPanelSheet`.
- `ActivityPanel.tsx`:
  - takes its route type from `activityPaneState`;
  - focuses the heading only after the user navigates (`userNavigatedRef`);
  - runs `focusRequested` only after an expand the user started.
- `ProviderTerminalActivityDock.tsx`:
  - renders `ActivityPane` for `terminal:<terminalId>` once observation is
    proven (the existing visibility rule), already in its saved state in that
    render;
  - when hidden: unchanged.
- Tests:
  - `ActivityDock.test.tsx`: the toggle and its ARIA attributes.
  - `ActivityPanel.test.tsx`:
    - a restored selected record does not focus the heading;
    - a user selection does focus it.
  - New `ActivityPane.test.tsx`:
    - expanding, collapsing, Escape, and focus;
    - the remembered route;
    - restoring at mount with focus left in an outside input;
    - a collapsed body that mounts no queries;
    - an expanded card at zero counts;
    - the height cap in a short pane.
  - `ProviderTerminalActivityDock.test.tsx`:
    - keep "keeps a pre-handshake snapshot hidden";
    - add: a saved expanded pane mounts expanded in the same render that
      proves observation, and no later record changes it;
    - replace "opens the exact persisted terminal scope" with "expands in
      place; the right panel is untouched".

### 3. Mounts (web; granted `ChatView` ranges)

- `ChatView.tsx`:
  - Delete the right-panel activity plumbing.
  - Mount `ActivityPane` as the first child of the composer overlay's
    `pointer-events-auto` column (about lines 7376–7385), above
    `ComposerBannerStack`.
  - Gate the host on its surface being visible.
  - Add `activityPaneHostRef` to `ChatViewPanelProps` and pass it at about
    line 1422.
  - Change nothing at or after line 3998, nor any follow or scroll code.
- `ThreadTerminalPanel.tsx`, about line 2370:
  - The wrapper becomes a flex column: the xterm mount is `min-h-0 flex-1`.
  - The bottom slot is in the flow and keeps
    `data-provider-terminal-activity-host`.
- Tests:
  - `ChatView.test.tsx`, rewritten:
    - 1441, 1821, 1860, 2266, 2735, 2782, 2846, 3117, 3175, 3217, 4366.
  - `ChatView.test.tsx`, deleted:
    - 1905, 1937, 1979, 2706, 3252, 3334, 3444, 3554, 3603.
  - New `ChatView.activityPane.test.tsx`:
    - two split panes are independent;
    - a focused sibling does not hide the host;
    - toggling changes the composer-overlay inset, and LegendList keeps
      `scrollTop` mid-history and the end at the end, and the top of an
      anchored just-sent turn does not move (mocked list state). If any of
      these fails, report it to the coordinator;
    - `rightPanelStore` is untouched;
    - the panel is restored at mount after a reload while the composer has
      focus.
  - `ChatView.hooks.test.tsx`: drop only the `openActivity` setup at about
    line 3030, the edit the API removal forces.
  - `ActivitySurfaces.test.tsx`: drop the `RightPanelSheet` wrapper.
  - `ThreadTerminalPanel` component test: toggling the slot triggers a refit
    and a resize RPC.

### 4. Right-panel surface removal (web)

- `rightPanelStore.ts`:
  - remove the kind, its type, actions, focus requests, and selector;
  - storage version 10 → 11;
  - when Activity was the active surface, migrate to closed with the first
    remaining surface active.
- `RightPanelTabs.tsx`: remove the activity cases.
- `rightPanelLayout.ts`: delete the inset constant.
- `rightPanelStore.test.ts`:
  - delete lines 122–368;
  - rewrite line 915 as migration cases: Activity was the only surface,
    active among others, or inactive among others.

### 5. #192 server fix (Rust; granted)

- `provider_terminal/codex.rs`:
  - `prepare_unix` returns a skip reason instead of `None`;
  - add a stage cell, so a timeout can report its stage;
  - log once per executable and reason, with the levels from the design's
    table;
  - add `observer_connect_failed` and `root_discovery_stopped` logs;
  - `CODEX_PREPARATION_BUDGET` becomes 4 s;
  - start `SYSTEM_CODEX_HELPER_SUPERVISOR` from
    `CodexTerminalObserverFactory::system()`;
  - `wait_ready` waits for the rest of the preparation budget instead of
    100 ms;
  - add the `helper_supervisor_unavailable` reason;
  - unit test: a cold supervisor initialization that is late, but within the
    budget, still prepares the first launch.
- `provider_terminal/supervisor.rs`:
  - add a `codex` arm returning 4.25 s from `preparation_execution_budget`;
  - the `None` arm stays unlabelled.
- `terminal/manager.rs`:
  - `MAX_PREPARATION_EXECUTION_BUDGET` becomes 4.5 s;
  - `NATIVE_COMMAND_TIMEOUT` becomes its own 1 s constant.
- Tests:
  - unit tests in `codex.rs` for each skip reason and stage;
  - in `tests/provider_terminal_supervisor.rs` (requested grant):
    - manager → supervisor → Codex with a helper delayed 1.5 s: the launch is
      prepared with `--remote`, publishes, and on close the helper is
      terminated and its directory removed;
    - a helper that is never ready: the launch passes through within the
      budget, cleans up, and logs `preparation_timeout stage=helper_ready`,
      captured with `tracing::subscriber::set_default`.

### 6. Packaged end-to-end (`chat-activity-panel.e2e.ts`, `support/activity-events.ts`)

- **Remove:** the right-panel toggle steps (lines 654–656, 895–906, 925–929),
  the sheet assertions at 960 px, and `sheet`.
- **Add:**
  - Chat:
    - the panel's rectangle lies within `[data-chat-surface]`, above the
      composer editor, and the composer is fully visible;
    - `aria-expanded` goes true, then false;
    - Escape returns focus to the dock;
    - the right panel is unchanged;
    - `scrollTop` is unchanged mid-history; an at-end list stays at the end;
      toggling after a send keeps the anchored turn's top in place.
  - Terminal:
    - expanding its own card shrinks xterm's rows and resizes the PTY;
    - with the fixture grant, the TUI redraws `fixture-tui <cols>x<rows>`;
    - collapsing restores the rows;
    - the chat's state is independent.
  - **Narrow split:** two chat panes, then a chat and a terminal pane, at
    960 px. Each card stays inside its pane. The composer editor stays fully
    visible, with height above 0. At least 5 terminal rows remain while
    expanded. The dock and the body's first control can be reached by Tab.
  - **Reload cases:**
    - a restored section with a detail route: the detail heading is shown,
      and focus stays in the composer or terminal;
    - a split pane after reload keeps each pane's state;
    - a seeded version 10 right-panel state pointing at `activity` hydrates
      with the right panel closed.
- **Keep:** the terminal geometry, the update assertions, and the
  missing-dock diagnostics.

### 7. Documentation

- `docs/user/workspace-ui.md:1752-1770`: the panel above the composer and at
  the terminal's bottom, the toggle, Escape, per-pane memory, and that the
  right panel is no longer used.
- `docs/reference/workspace-layout.md:65-69`: drop Activity from the
  right-panel surfaces; add the per-pane Activity panel to the center panes.
- `docs/architecture/activity-observation.md`:
  - line 524: "terminal Activity panel";
  - about line 485: the new stage-specific preparation logs and the Codex
    budget.
- `docs/testing/linux-desktop.md:758` and
  `docs/testing/cross-platform-validation.md:2970`: replace the "reopening the
  global right panel" check with the per-pane panel checks.
- `docs/testing/cross-platform-validation.md:3025-3029`: dock toggle
  semantics.
- `docs/testing/cross-platform-validation.md:3110-3112`: for a missing
  terminal dock, read the stage-specific Codex warnings in `app-server.log`
  before treating it as a layout fault.

## Validation, in phase 2

- From `apps/web`: `vp test run --project unit` on the changed tests.
- `vp check --no-fmt`, plus `vp check <changed files>`.
- `vp run typecheck`.
- `vp test run scripts/bibcode-identity.test.ts`.
- Rust, with its own `target/`, `CARGO_BUILD_JOBS=4`, and the 1.98.1
  toolchain:
  - `cargo fmt --all --check`;
  - `cargo test -p bibcode-server --lib provider_terminal`;
  - `cargo test -p bibcode-server --test provider_terminal_supervisor`;
  - `cargo test -p bibcode-server --lib terminal::manager`;
  - `cargo clippy -p bibcode-server --all-targets -- -D warnings`.
- Packaged end-to-end on macOS arm64 locally: the chat-activity spec only.
  macOS x64 runs in the coordinator's single batched push.
- Reviews:
  - `vercel-react-best-practices` for the changed components and hooks;
  - `UI.md` for the toggle, Escape, focus, in-flow slot, empty state,
    narrow split, and `data-text-surface`.

## Skipped (ponytail)

- Resizing the panel, and animating it.
- Attaching the Codex observer late (rejected in the design).
- Probe pre-warming.
- Claude's capped 3.25 s budget (recorded as a residual risk, not changed).
