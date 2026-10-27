# Inline Activity panel per pane (#188) and the macOS x64 terminal dock (#192)

Status: proposed, awaiting approval. Batch `activity-inline`, branch
`claude/b3-activity-inline` from `origin/develop` at `27702287cc`.

## 1. #192: why the live Codex terminal dock never shows on macOS x64

### What the failure is, and is not

The issue says the diagnostics show "an activity host but no geometry". The
host had geometry. The failure dump from run `40428617333` (job
`121940550460`, `macos-26-intel`) lists four elements:

| Element                                     | Size    | Visible |
| ------------------------------------------- | ------- | ------- |
| `center:root` body target                   | 840x643 | yes     |
| `chat:host` surface                         | 840x643 | hidden  |
| `terminal:term-1` surface                   | 840x643 | yes     |
| `[data-provider-terminal-activity-host]`    | 832x607 | yes     |

The fifth selector in the dump,
`[data-provider-terminal-activity-host] [data-testid='activity-dock']`,
matched nothing. The dock node was never rendered. This is not a layout fault.

The host is mounted from the client-side launch command alone
(`ThreadTerminalPanel.tsx:2399`, `command?.activity !== undefined`). The dock
inside it renders only after a terminal-scope snapshot arrives with
`capabilities.terminalObservation` and visible records
(`ProviderTerminalActivityDock.tsx:65-73`). On x64 no such snapshot arrived.
That means the server never attached the Codex terminal observer.

### Evidence

1. **The observer never ran on x64.** The arm64 `app-server.log` from the same
   run contains a `bibcode_server::provider_terminal::codex` line after the
   terminal opens. The x64 log contains no line from that module for the whole
   run. The module logs only once the observer is live.
2. **Process start on the x64 runner is two to three times slower.** The Claude
   activity probe runs one `#!/bin/sh` -> `node <fixture>.mjs --help`. It took
   684 ms and 1120 ms on x64, against 290 ms and 392 ms on arm64 (same run,
   `production::provider_runtime` warnings).
3. **Codex preparation has a fixed 350 ms budget.** `prepare_inner` wraps the
   whole of `prepare_unix` in `CODEX_PREPARATION_BUDGET = 350 ms`
   (`apps/server/src/provider_terminal/codex.rs:77,451`). That budget covers:
   - three probe runs, which are shell-only in the fixture and fast;
   - starting the helper `codex app-server --listen unix://…`, which in the
     fixture is `exec node codex-fixture.mjs`;
   - waiting for the helper's socket.

   A node cold start of 700 to 1100 ms cannot fit in 350 ms. The manager also
   caps the whole supervisor preparation at 500 ms for every driver except
   OpenCode, which gets 1 s (`terminal/manager.rs:41-42`,
   `provider_terminal/supervisor.rs:1116-1140`).
4. **The timeout is silent by design.** It resolves `.ok().flatten()` to
   `None`. The supervisor maps `None` to `PassThrough` at `supervisor.rs:481`.
   Every other pass-through reason on that path calls `warn_once`; this one
   does not. That is why the log says nothing.
5. **It is deterministic.** The chat-activity scenario failed on macOS x64 in
   all three runs (`40351666280`, `40390697884`, `40428617333`). It never
   failed on macOS arm64 in those runs. The arm64 margin is thin: about
   290–390 ms of node start against a 350 ms budget.

Root cause (high confidence, inferred): on the slower Intel runner, Codex
terminal observer preparation goes over its fixed 350 ms budget while it waits
for the node-backed helper's socket. The launch passes through silently, so no
terminal activity is ever published.

The same failure can plausibly hit real users. This was not verified in this
session, and no Codex sources are vendored under `.repos/`:

- A Codex installed through a package manager that wraps the binary in a Node
  launcher would pay a Node start for each probe and for the helper.
- A cold start, or a first-launch Gatekeeper scan on a slow Mac, can run past
  350 ms on its own.

What the code does show: a timed-out probe is cancelled before
`CachedCodexCapabilityProbe::probe` caches it (`codex.rs:155-168`). The next
launch therefore probes again from cold.

### Why not a Rosetta run

Under Rosetta, the x86_64 app would still `exec` the arm64 `/bin/sh` and the
arm64 `node` from `PATH`. The helper would start at native arm64 speed, so the
run cannot reproduce the suspected slow start. It would cost one full x86_64
release build for compatibility evidence that does not test the hypothesis.
I skipped it.

### Fix (outside this batch's owned files)

All of the fix is in `apps/server`, which this batch does not own:

1. **Log the timeout.** Add `warn_once("preparation_timeout", …)` in the
   `None` arm at `supervisor.rs:481`. Better, have Codex `prepare_inner` log
   which stage it was in (probe or helper readiness) and how long it took. This
   is required anyway by AGENTS.md ("log failures at operational boundaries").
   It is also the single batched CI diagnostic: one `Packaged Desktop UI Smoke`
   dispatch on macOS x64 should show `stage=helper_ready elapsed≈350ms`.
2. **Give Codex a budget that fits a Node-launched helper.** Follow OpenCode,
   which has 850 ms inner and 1 s outer. Raise `CODEX_PREPARATION_BUDGET`, and
   return 1 s for `codex` from
   `ProviderTerminalActivitySupervisor::preparation_execution_budget`.
   - Cost: up to about 0.65 s more launch latency, only when the observer is
     slow.
   - On the x64 runner (700–1100 ms node start) even 1 s is marginal. The owner
     should decide whether the helper may outlive the launch budget, starting
     the TUI pass-through and attaching later. That needs the TUI's
     `--remote` endpoint at spawn, so it is a larger change.
3. **Cache the probe outside the budget.** Let the capability probe finish
   detached and cache its result even when the launch budget expires. This is
   the pattern Claude's `CLAUDE_ACTIVITY_PROBE_RUN_TIMEOUT` already uses.

Item 1 is the smallest change that makes the failure visible, and the
diagnostic run proves the premise. Items 2 and 3 are the behavioral fix. The
#188 redesign does not remove this path: the terminal dock still needs a
terminal-scope snapshot. **Requested: assign the `apps/server` change to an
owner, or widen this batch's ownership to `provider_terminal/codex.rs` and
`provider_terminal/supervisor.rs`.**

## 2. #188: an inline Activity panel inside each chat and terminal pane

### Requirements, from the issue

- R1: The dock opens an inline panel in the same pane. The right panel never
  opens or changes.
- R2: The panel collapses and expands from the dock or its header, by mouse and
  by keyboard, with `aria-expanded` and focus handling. Collapsing does not
  shift scroll.
- R3: The panel is scoped to that pane's chat (root plus descendants) or that
  terminal. Each split pane has its own panel.
- R4: It works the same in chat panes and terminal panes.
- R5: The right-panel `activity` surface is removed, and persisted state is
  migrated.
- R6: Each pane's expanded state persists across reloads, and so does its
  route.

### Where the panel lives

There is one component, `ActivityPane` (new, in
`components/activity/ActivityPane.tsx`). It renders a single card anchored to
the pane's top-right corner. The card holds:

- **Header:** the existing dock summary row, turned into a disclosure toggle.
- **Body:** the existing `ActivityPanel` (tabs, roster, record detail), shown
  only while expanded.

The card overlays the pane. It is positioned absolutely, in the same place the
dock is today:

- **Chat:** inside the `relative` messages wrapper at `ChatView.tsx:~7279`,
  above `MessagesTimeline` and never in its flex flow. The composer stays
  visible below the wrapper.
- **Terminal:** inside the existing `data-provider-terminal-activity-host`
  overlay (`ThreadTerminalPanel.tsx:2399`). That overlay is
  `pointer-events-none`; the card sets `pointer-events-auto`.

Size:

- Width is `min(26rem, 100% - 1.5rem)`.
- Height is `min(32rem, 100% - 1.5rem)` of the pane area under the dock.
- In a narrow split pane the card takes the pane's width.
- The body scrolls inside its own `ScrollArea`, as it does today.

Alternatives considered:

| Option                                                    | Rejected because                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-flow panel above the composer or at the timeline's top | Changes the LegendList viewport height on every toggle. That moves the reading position or re-triggers end-follow, which another agent owns. In a terminal it resizes xterm and the PTY, so the Codex or Claude TUI redraws on every toggle.                                                                                                                                                             |
| Full-height drawer along the pane's right edge            | Covers the whole pane height, including the end of the timeline, even when there are few records. The anchored card grows only to its content.                                                                                                                                                                                                                                                           |
| Resizable card                                            | The issue makes it optional ("if resizable"). It adds a drag handle, a persisted size, and keyboard resizing. **Skipped in this change.**                                                                                                                                                                                                                                                                  |

Trade-off: while expanded, the card covers part of the timeline or terminal
under it. The pane itself does not move, so collapsing restores exactly what
was there. This is how R2's "without shifting scroll position" is met, by
construction: the timeline's and the terminal's geometry never change.

### Interaction and accessibility

- **The dock becomes the header.**
  - It is a toggle button with `aria-expanded` and `aria-controls` pointing at
    the body's id.
  - Its name drops "Open": `Activity: <breakdown>`. The breakdown is the
    existing per-section text, so the name stays stable across states. The
    tooltip keeps the breakdown.
  - A chevron shows the state.
- **Expanding (click, Enter, or Space on the collapsed dock):**
  - It opens on the section `sectionToOpen` picks: error first, then running
    work, then most recent.
  - If that is the remembered section, the remembered record stays open. If
    not, the section switches and the selection clears. This matches
    `openActivity` today.
  - Focus moves to the selected section tab, or to the panel when there is
    only one section. The existing `focusRequested` effect in
    `ActivityPanel.tsx` does this; the request becomes component-local state
    instead of `rightPanelStore.activityFocusRequests`.
- **Collapsing:**
  - The dock toggles it, and focus stays on the dock.
  - Escape anywhere inside the body collapses it and moves focus to the dock.
  - Escape is handled only in the card's own `onKeyDown`, so terminal and
    composer key handling are untouched.
- **Non-modal:** no focus trap, no backdrop, no outside-click dismissal. Tab
  order runs dock, then body, then the rest of the pane.
- **Collapsed means unmounted.** A collapsed body unmounts, so its
  roster and detail queries stop. Re-expanding revalidates, as reopening the
  inspector does today.
- **Visibility:**
  - The card is shown only while the dock would be visible. The existing rules
    apply: `alwaysVisible` for chats; terminals wait for a record.
  - An expanded card stays visible even if the counts drop to zero, and shows
    the panel's empty state. Otherwise the content would vanish under the
    user's hands.
  - After a reload, a remembered expanded pane opens expanded without taking
    focus.
  - Open judgment call: a terminal pane remembered as expanded reopens its card
    when its first record arrives after the reload. The card then covers part
    of a live TUI the user may be typing in. It is the user's remembered
    choice, and focus stays in the terminal. The alternative is to persist the
    route for terminal panes but always start them collapsed. **To be decided
    at approval.**
- **Behavior change:** the dock now closes an open panel. Today it never
  closes it (`docs/user/workspace-ui.md:1756-1762`). That is what the issue
  asks for ("collapsed and expanded from its header or the dock").
- **Remains:**
  - The live announcement region stays in the header.
  - The compact count layout stays under 1200 px.
  - The right-panel responsive sheet is no longer used for Activity.

### Scope and pane identity

- **Chat pane:** scope is always `{ _tag: "thread" }`, resolved for that
  `ChatView`'s own thread: the host thread, or the panel chat's
  `panelThreadRef`. The chat dock no longer takes its scope from a right-panel
  surface (`ChatView.tsx:2019-2039`). This removes the case where a terminal's
  activity showed in the chat's dock.
- **Terminal pane:** scope is `{ _tag: "terminal", terminalId }`, as today.
- **Pane key:** the center surface id. It is `chat:host`, `chat:<threadId>`,
  or `terminal:<terminalId>`, under the host thread key. Provider-terminal
  commands reach `TerminalViewport` only through `CenterTerminalPanel`
  (`ThreadTerminalPanel.tsx:2905,2937`). So only center terminals have a dock,
  and `terminal:<terminalId>` names the pane wherever it moves among center
  groups.
- **Host visibility:** `siblingChatOwnsCenter` (`ChatView.tsx:1992`) is
  deleted. It existed only because one right panel was shared, and it wrongly
  hid the host dock whenever a sibling chat in a split was focused. The host
  card now renders when the host surface is visible, meaning some group's
  `activeSurfaceId === "chat:host"`. That is the same rule
  `CenterPanelSurfaceHosts` uses (`CenterPanelSurfaceHosts.tsx:263-267`). A
  hidden, tabbed-away host therefore mounts no dock and makes no live
  announcements.

### Per-pane persistence (`centerPanelStore`)

The store gets a new root field, persisted next to `byThreadKey`:

```ts
activityPanes: Record<threadKey, Record<surfaceId, ActivityPaneState>>;
interface ActivityPaneState {
  expanded: boolean;
  section: "subagents" | "backgroundTasks";
  selectedRecordKind: "actor" | "workItem" | null;
  selectedRecordId: string | null; // bounded, as today
}
```

- **Actions:** `setActivityPaneExpanded(ref, surfaceId, expanded, section?)`
  and `navigateActivityPane(ref, surfaceId, route)`. A route change for a
  surface not in that thread's `surfaces` is a no-op, so a stale navigation
  cannot recreate a closed pane.
- **Pruning:** the entry is dropped in every path that removes a surface:
  `closeSurface`, `closeOtherSurfaces`, `closeSurfacesToRight`,
  `closeAllSurfaces`, `removeTerminalPanel`, and `removeThread`. Migration also
  drops entries for surfaces that are not present.
- **Placement:** a root map rather than a field on `ThreadCenterPanelState`.
  This keeps layout reducers and `isImplicitDefault` untouched.
- **Migration:** `CENTER_PANEL_STORAGE_VERSION` goes from 3 to 4. A missing
  field migrates to `{}`. Malformed entries are dropped. The route
  normalizers (`normalizeActivitySection`, `normalizeActivitySelection`, and
  the bounded-id check) move from `rightPanelStore.ts` to a small
  `components/activity/activityPaneState.ts`. Both the store and its tests use
  it.
- **Hydration:** today `centerPanelStore` has `migrate` but no `merge`. That
  means a same-version store with a corrupt pane entry would hydrate unchecked.
  Add a `merge` that runs the `activityPanes` normalizer on every hydration,
  the way `rightPanelStore` does (`rightPanelStore.ts:1023`).
- **Panel chats need the host's ref.** A panel-variant `ChatView` reads the
  center state as empty (`ChatView.tsx:1924-1927`) and receives only
  `panelThreadRef`. `LiveCenterPanelWorkspace` already has `hostThreadRef` at
  the panel render site (`ChatView.tsx:1420-1424`). Add an optional
  `activityPaneHostRef` to `ChatViewPanelProps` and pass it there. The panel
  then reads and writes `activityPanes[hostKey]["chat:<threadId>"]`.
- **Defaults:** collapsed, on `subagents`, with nothing selected. Default
  entries are not written, so idle panes add nothing to storage.

### Removing the right-panel surface (`rightPanelStore`, `RightPanelTabs`)

- **`rightPanelStore.ts`:**
  - Remove `"activity"` from `RIGHT_PANEL_KINDS`.
  - Remove `ActivityRightPanelSurface` and its normalizers.
  - Remove `openActivity`, `navigateActivity`, `acknowledgeActivityFocus`,
    `activityFocusRequests`, and `selectActivityFocusRequested`.
- **Migration:**
  - `RIGHT_PANEL_STORAGE_VERSION` goes from 10 to 11.
  - `normalizePersistedSurface` already returns `null` for an unknown kind.
  - New: when the persisted `activeSurfaceId` was `"activity"`, migration sets
    `isOpen = false` and makes the first remaining surface active, or `null`.
    Old state then cannot reopen the right panel, whether on Activity or on
    whatever surface happens to be left.
  - A thread whose only surface was Activity is already closed by
    `allPersistedSurfacesWereInvalid`.
  - `merge` runs the same sanitizer, so live hydration is covered too.
- **`RightPanelTabs.tsx`:** remove the `activity` cases in `surfaceTitle`,
  `SurfaceIcon`, and the tooltip bypass.
- **`ChatView.tsx`:** remove the right-panel activity plumbing (section 4).
  Panel chats then never render a right panel:
  - `rightPanelSurfaceEligible` becomes `!isPanel`.
  - `renderedRightPanelSurfaces` becomes `rightPanelState.surfaces`.
  - `toggleRightPanel` loses the `hostActivitySurfaceSuppressed` branch.
- **`ActivityDock`:** drops `avoidRightPanelSheet`, because the right-panel
  sheet no longer hosts Activity.
  `ACTIVITY_DOCK_SHEET_INSET_CLASS_NAME` in `rightPanelLayout.ts` becomes
  unused and is deleted.

### Disabled settings

With **Chat agent activity** or **Terminal agent activity** off, the card does
not render and no activity atom is read, as the dock behaves today. Remembered
pane state is kept, so turning the setting back on restores the panes.

The effects that closed a persisted right-panel Activity surface when its
setting was off (`ChatView.tsx:2041-2074`) are deleted.

## 3. Profiler, crash, and trace coverage

#188 is web-only. It adds no process, RPC method, worktree path, binary mode,
service, or profiler event, so no coverage item applies.

The proposed #192 server change adds a `tracing::warn!` at an operational
boundary. It touches no other coverage item.

## 4. Ownership needed beyond the brief

1. **`ChatView.tsx` beyond the `ActivityDockBinding` region.** These ranges are
   all activity plumbing, with no follow, scroll, or sent-row code:
   - 465–619 and 636–993: `useBoundedActivityQuery`, `ActivityStateTarget`,
     `ActivityDockBinding`, `ActivityPanelBinding`, and their error helpers.
     They move to `components/activity/ActivityPaneBinding.tsx`.
   - 1992 and 2001–2107: the activity scope, `siblingChatOwnsCenter`, and the
     persisted-surface effect.
   - 3711–3723, 3786–3807, and 3845–3856: right-panel toggling and close
     handlers.
   - 7192–7200: the `ActivityPanelBinding` right-panel branch.
   - 7281–7295: the dock mount, which becomes the `ActivityPane` mount.
   - About 1060 and 1420–1424: the `ChatViewPanelProps.activityPaneHostRef`
     prop, and passing it from `LiveCenterPanelWorkspace`.
   - The imports those use.
2. **`apps/desktop/e2e/support/activity-events.ts:124`**
   (`desktopActivityAccessibleNames.dock`), for the renamed dock label.
3. **`apps/web/src/rightPanelLayout.ts`**, to delete the now-unused inset
   constant.
4. **Tests outside the named list:**
   - `ChatView.hooks.test.tsx:~3030` calls `openActivity`.
   - `rightPanelStore.test.ts` activity cases at lines 122–368 and 915.
   - `centerPanelStore.test.ts` for the new state.
5. **The #192 server files** (section 1).
