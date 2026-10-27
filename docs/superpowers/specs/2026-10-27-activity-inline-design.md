# Inline Activity panel per pane (#188) and the macOS x64 terminal dock (#192)

Status: #188 approved and implemented. #192 has been re-planned as
instrument-then-fix: Phase A (stage instrumentation only) is committed as
`f5e26d3f2b`, and Phase B waits for the macOS x64 stage line. Batch
`activity-inline`, branch `claude/b3-activity-inline` from `origin/develop` at
`27702287cc`.

### #192 re-plan (supersedes the fix and logging sections below)

The disproved premise was that the existing artifacts show which stage fails.
They do not, so the work is now split.

**Phase A**, commit `f5e26d3f2b`, is a standalone Rust commit that applies
cleanly to `origin/develop`. It changes no budgets.

- Every silent exit in `provider_terminal/codex.rs` logs a distinct `reason`
  with `elapsed_ms`:
  - each preparation stage;
  - helper readiness, including the existing 3 s readiness failure, as
    `helper_start_failed`;
  - an abandoned helper start, with its sub-step;
  - the post-spawn connect;
  - root discovery;
  - resume;
  - live publication.
- A build whose version the probes cannot parse is cached, so it passes
  through without spawning. Unsupported capabilities were already cached and
  never wait.
- `supervisor.rs` (admission gating, which #187 owns), `model.rs`, and
  `manager.rs` are untouched.

Phase A also settles one fact from the existing artifacts. The manager's
isolated-callback timeout warning ("provider terminal observer callback timed
out") is absent from the x64 log, so the outer 500 ms cap never expired.

**Not done:**

- No eager supervisor start: it would have no shutdown owner.
- No budget raise until the x64 stage line and Intel timings are in.

**Phase B** is the actual fix. It is chosen from the batched run's stage line.
If the helper supervisor turns out to be slow, `wait_ready` uses the remaining
preparation budget, with initialization still lazy. Its tests:

- a production-equivalent helper failure, separately from expiry of the outer
  preparation budget;
- first-launch supervisor readiness through the complete caller. The existing
  fixture launcher bypasses the process-wide supervisor
  (`provider_terminal_supervisor.rs`, about line 4536), so that test needs the
  system launcher.

Round 2 changes the design in these ways:

- **Placement:** the panel now sits in the pane's flow, above the composer or
  at the bottom of the terminal. It no longer floats over the pane.
- **#192 confidence and timings:** the confidence is restated honestly, with
  Codex-specific stage timings measured from the real fixture.
- **#192 fix:** chosen so the first launch succeeds on a slow machine.
- **#192 logging and testing:** each failure stage now gets its own log line,
  and a Rust test runs the full chain.
- **Restore and focus:** saved state is restored when a pane mounts, and the
  record heading takes focus only after a user selects a record.
- **Additional coverage:** pruning on main-pane replacement, more packaged
  cases, and documentation updates.

## 1. #192: the live Codex terminal dock never shows on macOS x64

### What the failure is

The diagnostics in the failure dump show the pane geometry and visibility were
correct:

- The terminal surface was visible.
- Its activity host was visible, at 832x607.

The dock node was never rendered: the selector
`[data-provider-terminal-activity-host] [data-testid='activity-dock']` matched
nothing. The host itself is mounted from the client's launch command alone
(`ThreadTerminalPanel.tsx:2399`). The dock renders only once a terminal-scope
snapshot with `capabilities.terminalObservation` and visible records arrives
(`ProviderTerminalActivityDock.tsx:65-73`).

So on x64 the Codex terminal observer never published anything. That is not a
layout fault.

### What the artifacts do and do not show

These are from run `40428617333` (`macos-26-intel` against arm64), plus the
pass and fail pattern of runs `40351666280` and `40390697884`.

- **The failure is consistent.** The chat-activity scenario failed on macOS x64
  in 3 of 3 runs, and on macOS arm64 in 0 of 3.
- **The x64 observer never logged.** The arm64 server log has a
  `provider_terminal::codex` warning that is emitted only during descendant
  reconciliation, which runs after the root has been found. The x64 log has no
  line from that module at all.

  This narrows the failure to one of three stages, none of which logs today:
  1. Preparation (`codex.rs:451`): the capability probes and the helper
     `app-server --listen`, under a 350 ms budget inside the manager's 500 ms
     cap.
  2. The post-spawn connect and initialize (`connect_initialized_codex_client`,
     with a 3 s limit). On failure the observer parks silently.
  3. Root discovery (`run_codex_observer_inner`, about `codex.rs:802-860`). It
     never finds the TUI root, or stops.

  The x64 artifacts contain **no Codex-specific timing**. The 684 ms and
  1120 ms figures belong to the Claude Node probe. They show that a Node
  process starts about 2.3 to 2.9 times slower on that runner than on arm64
  (290 ms and 392 ms). They do not time Codex.
- **Local stage timings for the Codex fixture.** I materialized the real e2e
  shims with `prepareDesktopUiTestContext` and timed each stage on this arm64
  machine, which was loaded by parallel agents. Eight trials:

  | Stage                                               | Measured (ms)              |
  | --------------------------------------------------- | -------------------------- |
  | Three probes (`--version`, `--help`, `app-server --help`) | 20–33 warm; 211 the first, cold |
  | Helper started until its socket accepts             | 174–592; median about 245; 4 of 8 over 350 |
  | Claude `--help` (calibration)                       | 177–500; median about 289  |

  The helper's readiness tracks a Node start closely: 0.6 to 1.3 times the
  Claude calibration. The x64 runner was 2.4 to 3.9 times slower than the
  local median on that calibration. Scaled up, that puts x64 helper readiness
  at about 0.6 to 2.3 s. A first, cold launch adds probes of up to about
  0.8 s.

  Every estimate exceeds the 350 ms budget and the 500 ms outer cap.

Confidence:

- **Medium-high** that preparation times out, at the helper-ready stage.
  Every scaled estimate exceeds the budget, and the arm64 runner passes on a
  margin the local trials show is thin.
- **Not proven.** A post-spawn connect or discovery failure would leave the
  same silent log. The stage logs below are needed in any case. The batched CI
  run decides between the three stages: either the dock appears, or the log
  names the stage.

A Rosetta run was skipped. Under Rosetta the app still runs the arm64 `node`,
so it cannot reproduce a slow helper start.

### Fix: the first launch must succeed on a slow machine

Two approaches were considered.

**A. Attach late.** Start the TUI at once and connect the helper afterward.
Rejected, for two reasons:

- The Codex TUI needs `--remote unix://…` when it is spawned. Whether a TUI
  whose socket is not yet listening retries or exits is not established, and
  no Codex sources are vendored here to check.
- The alternative is to open the terminal RPC before the PTY is spawned. That
  changes the manager's lifecycle and its cancellation guarantees, which is far
  more than #192 needs.

**B. Raise both budgets from measured timings, with margin.** Chosen. The
budget is a cap, not a wait, so a fast machine spawns as soon as the helper is
ready. Only a slow machine waits longer, and on that machine the alternative is
no Activity at all.

| Constant                                                                 | Now                            | New                                                     |
| ------------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------- |
| `CODEX_PREPARATION_BUDGET` (`codex.rs:77`)                               | 350 ms                         | 4 s                                                     |
| Codex result of `preparation_execution_budget` (`supervisor.rs:1116-1140`) | 500 ms (default)               | 4.25 s, adding a `codex` arm next to `opencode`         |
| `MAX_PREPARATION_EXECUTION_BUDGET` (`manager.rs:42`, applied at `:2079`) | 1 s                            | 4.5 s                                                   |
| `NATIVE_COMMAND_TIMEOUT` (`manager.rs:45`)                               | aliases the 1 s cap            | its own 1 s constant, so native-command probes do not change |

The 4 s figure covers the worst estimate for a cold first launch: about 3.1 s,
made of 2.3 s of helper start and 0.8 s of cold probes. It sits just above
`CODEX_HELPER_READY_TIMEOUT` (3 s). The helper's own readiness timeout already
assumes a start of up to 3 s; the old 350 ms outer budget contradicted it.

The margin is about 30% over the worst estimate, and about four times the
median estimate. If the batched run shows a helper-ready time above about 3 s,
the next step is to look at the helper's cold start itself, not to raise the
budget again.

**The first launch has a second fail-open path the budgets do not reach.**
`SystemCodexHelperLauncher::start` waits for the process-wide helper
supervisor (`codex.rs:2127-2130`). That supervisor is a `LazyLock`
(`:2307-2313`), started by the first Codex terminal launch in the process, and
`wait_ready` gives up after `CODEX_HELPER_SUPERVISOR_INIT_TIMEOUT = 100 ms`
(`:76, :2389-2405`). Starting it means spawning a thread and building a
current-thread Tokio runtime. That is normally a few milliseconds, but it is
not bounded on a loaded runner.

The e2e opens exactly one Codex terminal, which is that first launch. If
initialization misses 100 ms, the launch passes through whatever the budgets
are.

The fix has two parts:

1. Start the initializer when `CodexTerminalObserverFactory::system()` is
   built, at server start, so the first launch finds it ready.
2. Have `wait_ready` wait for the rest of the preparation budget instead of a
   fixed 100 ms.

The existing tests at `:3920-3945` and `:3980-4030` keep their meaning: a
failed or late initialization still fails open, but now at the preparation
bound instead of at 100 ms. The skip reason is
`helper_supervisor_unavailable`.

Costs:

- On a slow machine, opening a Codex terminal can take up to about 4 s before
  the TUI appears, or before it passes through.
- That is within the profiler's 10 s hang threshold (`latency.rs:45`), so
  `terminal.open` stays out of `is_long_running`. A slow open may occasionally
  raise a relative `rpc.slow`; that is an accurate signal.
- Claude's own 3.25 s budget is still capped at the 500 ms default. That is
  left unchanged here and recorded as a residual risk.

### Logging stage by stage, at the point of failure

> **Superseded.** The reason names and levels actually shipped are listed in
> the living [Activity observation](../../architecture/activity-observation.md)
> document, in the paragraph after the pass-through rules. The table below is
> the round-2 proposal, kept as history. As built, each occurrence is logged;
> there is no once-per-executable limit.

The plain `Option` is replaced inside `codex.rs` with a reason. Each reason is
logged once per executable and reason, at the level it deserves:

| Where                                  | Reason                                                                                      | Level                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Probe                                  | `probe_failed` (spawn error or non-zero exit), `version_unparsed`                            | warn                                                                        |
| Capabilities                           | `unsupported_capabilities` (no unix listener or remote TUI)                                  | info, since it is expected for older Codex                                  |
| Arguments                              | `rejected_args` (`remote_tui_args` returned `None`)                                          | info                                                                        |
| Generation directory or socket path    | `generation_dir_failed`, `socket_path_too_long`                                              | warn                                                                        |
| Helper supervisor                      | `helper_supervisor_unavailable` (initialization failed or was late)                          | warn                                                                        |
| Helper                                 | `helper_start_failed`, with the launcher's error message, including readiness past `CODEX_HELPER_READY_TIMEOUT` | warn                                          |
| Budget expired (`prepare_inner`)       | `preparation_timeout`, with `stage` (`probe` or `helper_ready`) and `elapsed_ms`             | warn                                                                        |
| After spawn: connect or initialize fails | `observer_connect_failed`, with the error                                                  | warn                                                                        |
| After spawn: root discovery stops      | `root_discovery_stopped`                                                                     | warn                                                                        |

The stage for the timeout comes from a small atomic cell that `prepare_unix`
updates as it moves between stages. The supervisor's `None` arm at
`supervisor.rs:481` adds no label of its own: the factory has already said why.

**How to read the batched run.**

- **Success:** the dock appears, and none of the lines below is logged.
- **A slow helper:** the helper stage is bounded *inside*
  `SystemCodexHelperLauncher::start` by `CODEX_HELPER_READY_TIMEOUT` (3 s), so
  a helper that is too slow logs `helper_start_failed` with the readiness
  message, not a timeout.
- **`preparation_timeout`:** fires only when the probes, plus waiting for the
  supervisor, take more than the remaining 1 s. Its `stage` says which.
- **`observer_connect_failed` or `root_discovery_stopped`:** preparation
  worked, and the failure came after the spawn.

Each outcome points at a different next step, so a single push is readable.

Logs carry no paths or prompt content beyond the executable name, which the
existing `warn_once` calls already include. They use `tracing`, so they reach
the native log and trace. No profiler finding is added.

### Tests

- **Rust integration test** (`apps/server/tests/provider_terminal_supervisor.rs`,
  using the existing `codex_fixture_supervisor` harness):
  - Set up: `TerminalManager` with the supervisor and the Codex factory, and a
    `CodexFixtureHelperLauncher` whose readiness is delayed 1.5 s. That is
    longer than the old 350 ms, 500 ms, and 1 s caps, and shorter than the new
    ones.
  - Assert:
    1. The spawned command carries `--remote unix://…`.
    2. The observer publishes the terminal scope.
    3. Closing the terminal terminates the helper and removes the generation
       directory.
- **Second integration test:** a helper that never becomes ready. Assert that
  the launch passes through within the new budget plus slack, that the helper
  is terminated, that the directory is cleaned up, and that the
  `preparation_timeout stage=helper_ready` warning is recorded. The warning is
  captured with the `tracing::subscriber::set_default` pattern that
  `tests/production_provider_runtime.rs:8769` already uses.
- **Unit tests:** each reason maps to its log. The two existing tests that
  assert `elapsed < CODEX_PREPARATION_BUDGET` (`codex.rs:3936,4008`) are bounds
  on the supervisor initializer. They keep their meaning; only the constant
  grows.
- **Acceptance:** the macOS x64 `chat-activity-panel` assertion passes in one
  batched CI push. The coordinator pushes, not me. A warning by itself is not
  the fix.

## 2. #188: an inline Activity panel in each chat and terminal pane

### Requirements, from the issue

- **R1:** The dock opens an inline panel in the same pane. The right panel never
  opens or changes.
- **R2:** It collapses and expands from the dock or its header, by mouse and by
  keyboard, with `aria-expanded` and focus handling. Collapsing returns the
  pane to its normal layout without shifting scroll.
- **R3:** It is scoped to that pane's chat (root plus descendants) or that
  terminal. Each split pane has its own.
- **R4:** It works in chat and terminal panes.
- **R5:** The right-panel `activity` surface is removed and persisted state is
  migrated.
- **R6:** Each pane's expanded state and route persist across reloads.

### Placement: in the pane's flow, in its bottom slot

There is one component, `ActivityPane` (`components/activity/ActivityPane.tsx`).
It is a single card with two parts:

- **Header:** the dock's summary row, which becomes a disclosure toggle.
- **Body:** the existing `ActivityPanel` (tabs, roster, record detail), shown
  only while expanded.

The card is docked in the pane's bottom slot. The dock moves with it, so the
toggle and its content stay together.

**Chat pane.** The card is the first child of the composer overlay's
`pointer-events-auto` column (`ChatView.tsx:~7376-7385`), above
`ComposerBannerStack`. It is aligned with the composer and has the same maximum
width.

- That overlay is the region whose height already changes as the composer grows
  or banners appear. `composerOverlayHeight` is measured by a ResizeObserver
  (`ChatView.tsx:1745-1762`) and becomes the timeline's
  `contentInsetEndAdjustment` (`ChatView.tsx:7344`).
- **The reading anchor on height change is already handled, by LegendList
  3.3.10 itself.** `updateContentInsetEndAdjustment` (`react.mjs:7291-7304`)
  keeps `state.scroll` when the inset changes. It adds the difference only when
  the list was within the end threshold and the inset grew.
  - Away from the end: `scrollTop` does not change, and the content above does
    not move.
  - At the end: the list stays at the end.
  - Shrinking at the end: the browser clamps to the new end.

  The ChatView code that reads `composerOverlayHeight` (`:4031, :4060, :4088`)
  is the same code a growing composer exercises.
- **No new follow code.** Phase 2 includes unit tests and packaged
  assertions for three scroll states:
  1. Toggled while reading mid-history, `scrollTop` does not change.
  2. Toggled at the end, the list stays at the end.
  3. Toggled after a send, while the sent turn is anchored and before the
     reply arrives, the anchored turn's top does not move.
     `getAnchoredTurnMetrics` reads `composerOverlayHeight`
     (`ChatView.tsx:4020-4035`), and that is the code the follow agent is
     changing.

  If any of these shifts, I report the symptom to the coordinator and do not
  touch follow code.

**Terminal pane.** `TerminalViewport`'s wrapper (`ThreadTerminalPanel.tsx:2370`)
becomes a flex column: the xterm mount is `min-h-0 flex-1`, and the card sits in
a bottom slot after it. The slot keeps
`data-provider-terminal-activity-host={terminalId}` for diagnostics and tests;
it is no longer absolute.

- The xterm container's ResizeObserver (`ThreadTerminalPanel.tsx:~2303`)
  refits the terminal. The PTY is resized on expand and collapse, and the TUI
  redraws through SIGWINCH.

**Size.**

- The collapsed card is one header row of about 40 px. It is present only while
  the dock would be visible.
- The expanded body's maximum height is the smaller of 22 rem and 45% of the
  pane. It is measured from the pane element (chat column or terminal
  wrapper), so a short split pane keeps at least 55% for the timeline and
  composer, or for terminal rows. The body scrolls in its own `ScrollArea`.
- The scrollable content wrapper carries `data-text-surface="card"`
  (`UI.md:175`; `index.css:383-396`).

Alternatives considered:

| Option                                                                  | Rejected because                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Floating card over the pane (round 1)                                   | The issue asks for a panel docked in the pane that collapses back to the normal layout. An overlay hides content without the layout acknowledging it.                                                                                                                  |
| Keep the collapsed dock floating at the top right; dock only the body at the bottom | It costs no row while collapsed, but it separates the control from the content it controls, at opposite ends of the pane. The issue says the dock and header both toggle.                                                                                              |
| Panel at the top of the timeline                                        | It changes the viewport from the top, so LegendList's end-inset path does not cover it, and it would need new anchor code in code another agent owns.                                                                                                                 |
| Resizable card                                                          | Optional in the issue. **Skipped.**                                                                                                                                                                                                                                   |

Cost: a chat whose provider reports activity, with **Always show Activity** on
(the default), keeps about a 40 px row above the composer. A terminal gives up
about two rows while its dock is visible.

### Interaction, accessibility, and focus

- **The header is the dock.**
  - It is a toggle with `aria-expanded` and `aria-controls` pointing at the
    body's id.
  - Its name is `Activity: <breakdown>`, which stays the same in both states.
  - A chevron shows the state.
  - The live announcement region stays in the header.
- **Expand** (click, Enter, or Space):
  - It opens on `sectionToOpen`. When that is the remembered section, the
    remembered record stays open. Otherwise the selection clears.
  - Focus moves to the selected section tab, or to the panel when there is only
    one section. The focus request is component-local; it is no longer kept in
    `rightPanelStore.activityFocusRequests`.
- **Collapse:**
  - From the dock, focus stays on the dock.
  - Escape inside the body collapses it and focuses the dock. The handler is on
    the card, so the composer's and xterm's key handling are untouched.
- **Non-modal.** No focus trap, backdrop, or outside-click dismissal.
- **Collapsed means unmounted.** A collapsed body unmounts, so its queries
  stop. Re-expanding revalidates them.
- **When the card shows** follows the existing rule for the button. An open
  card whose counts fall to zero follows the same rule. As built, it has no
  extra "stay open" state; done records keep counting, so in practice the card
  stays. The sticky variant was dropped: it needed a set-state-in-effect, and it
  double-subscribed the activity atom on mount.
- **A reconnect does not close an open card.** While the snapshot is briefly
  gone (`null`), an open card keeps showing its last snapshot, so focus, the
  open record, and scroll survive. A snapshot that says hide, such as one with
  no records, still hides it. The held snapshot is derived state in a child
  (`ActivityPaneCard`), so the atom reader never re-renders for it.
- **Record-heading focus moves only after the user picks a record.** Today,
  `ActivityPanel.tsx:268-273` focuses the detail heading whenever a selected
  record is rendered. A restored route would therefore take focus from the
  composer or the terminal after a reload.
  - As built: `userOpenedRecordIdRef` records the record that `selectRecord`
    or `selectActor` opened. The heading takes focus only while the routed
    record is that record.
  - The `focusRequested` path (`:276-292`) runs only from an expand the user
    started.
- **Behavior change:** the dock now closes an open panel. Today it never does
  (`docs/user/workspace-ui.md:1756-1762`). This is what the issue asks for.

### Restoring saved state at mount

Both pane kinds read their saved `ActivityPaneState` synchronously at mount:
the store is persisted to localStorage and hydrated synchronously. The card's
first render therefore uses the saved expanded state and route. No effect or
arriving record ever expands it.

- **Chat panes.** The card renders at mount whenever the chat scope is enabled
  and the dock would be visible: with **Always show** on, from the first
  snapshot; otherwise once a record exists.
- **Terminal panes (recommended).** The card mounts when the server proves
  observation, which is the existing dock rule. In that same render it is
  already in its saved expanded or collapsed state and route. Only the store
  decides expanded versus collapsed, never an arriving record.
  - The cost is one PTY resize when the card mounts, which the TUI handles
    through SIGWINCH.
  - Rejected: mounting a placeholder card before the handshake to reserve the
    row. No pre-handshake signal says whether observation will ever attach:
    #192's pass-through publishes nothing. The time to a first snapshot on a
    slow machine is unbounded in practice: a 3 s connect, discovery on 1 s
    intervals, and up to 5 min of resume materialization.
  - Any timeout that removed a placeholder would make a card appear, vanish,
    and reappear on exactly the machines #192 is about.
  - **Resolution of review item 4 (approved):** the terminal card appears when
    the dock appears today, once observation is proven. It renders in its saved
    open or closed state in that same render. A placeholder before the
    handshake would need a server-sent "observation not attached" signal, which
    does not exist.
  - Tests:
    - `ProviderTerminalActivityDock.test.tsx`: a delayed handshake restores the
      saved open state when the card appears; an empty snapshot shows no card.
    - `ThreadTerminalPanel.interactions.test.tsx`: the same two cases through
      the mounted `TerminalViewport`, plus a reconnect (`stale`) that keeps the
      same open card.
- **Panel chats without a host layout.** A panel `ChatView` rendered without
  `activityPaneHostRef` keys its state the way a host does: under its own
  thread, as `chat:host`. Production always passes the host ref from
  `LiveCenterPanelWorkspace`.

### Scope and pane identity

- **Chat pane:** the scope is `{ _tag: "thread" }` for that `ChatView`'s own
  thread: the host thread, or `panelThreadRef`. The scope no longer follows a
  right-panel surface (`ChatView.tsx:2019-2039`).
- **Terminal pane:** the scope is `{ _tag: "terminal", terminalId }`.
- **Pane key:** the center surface id (`chat:host`, `chat:<threadId>`, or
  `terminal:<terminalId>`) under the host thread key. Only center terminals
  receive a provider command (`ThreadTerminalPanel.tsx:2905,2937`), so only
  they get a dock.
- **Panel chats need the host's ref.** A panel-variant `ChatView` reads its
  center state as empty (`ChatView.tsx:1924-1927`). Add
  `ChatViewPanelProps.activityPaneHostRef`, passed from
  `LiveCenterPanelWorkspace` (`ChatView.tsx:1420-1424`).
- **Host visibility:** `siblingChatOwnsCenter` (`:1992`) is deleted. The host
  card renders when some group's `activeSurfaceId === "chat:host"`, the rule
  `CenterPanelSurfaceHosts.tsx:263-267` uses. A focused sibling in a split no
  longer hides the host's dock, and a host that is tabbed away is not
  announced.

### Saved state per pane (`centerPanelStore`)

```ts
activityPanes: Record<threadKey, Record<surfaceId, ActivityPaneState>>;
interface ActivityPaneState {
  expanded: boolean;
  section: "subagents" | "backgroundTasks";
  selectedRecordKind: "actor" | "workItem" | null;
  selectedRecordId: string | null; // bounded, as today
}
```

- **Actions:** `setActivityPaneExpanded` and `navigateActivityPane`. Both are
  no-ops for a surface that is not in the thread's `surfaces`.
- **Pruning:** a `pruneActivityPanes(threadKey, surfaces)` step runs inside
  `withUpdatedThread`. It therefore covers every surface removal that goes
  through it (`closeSurface`, `closeOtherSurfaces`, `closeSurfacesToRight`,
  `closeAllSurfaces`, `removeTerminalPanel`), plus `replaceMainWithTerminal`
  (`centerPanelStore.ts:503-518`, which writes `byThreadKey` directly) and
  `removeThread`.
- **Placement:** a root map, so layout reducers and `isImplicitDefault` are
  unchanged.
- **Migration and hydration:**
  - `CENTER_PANEL_STORAGE_VERSION` goes from 3 to 4; a missing field becomes
    `{}`.
  - A new `merge` normalizes `activityPanes` on every hydration. The store has
    only `migrate` today.
  - Malformed entries, and entries for surfaces that are not present, are
    dropped.
  - The normalizers move from `rightPanelStore.ts` to
    `components/activity/activityPaneState.ts`.
- **Defaults:** collapsed, on `subagents`, with nothing selected. Defaults are
  not written.

### Removing the right-panel surface

- **`rightPanelStore.ts`:**
  - Remove the `"activity"` kind, `ActivityRightPanelSurface`, its
    normalizers, `openActivity`, `navigateActivity`,
    `acknowledgeActivityFocus`, `activityFocusRequests`, and
    `selectActivityFocusRequested`.
  - `RIGHT_PANEL_STORAGE_VERSION` goes from 10 to 11.
  - When the persisted `activeSurfaceId` was `"activity"`: set `isOpen = false`
    and make the first remaining surface active, or `null`.
  - When Activity was the only surface: the existing
    `allPersistedSurfacesWereInvalid` branch closes it.
  - `merge` already sanitizes every hydration.
- **`RightPanelTabs.tsx`:** remove the `activity` cases.
- **`ChatView.tsx`** (granted activity ranges):
  - Remove the right-panel activity plumbing.
  - `rightPanelSurfaceEligible` becomes `!isPanel`.
  - `renderedRightPanelSurfaces` becomes `rightPanelState.surfaces`.
  - `toggleRightPanel` loses its suppressed branch.
  - Lines 3845–3856 change only as far as needed to drop the panel-variant
    Activity close handlers. Nothing at or after 3998 changes.
- **`ActivityDock` and `rightPanelLayout.ts`:** remove `avoidRightPanelSheet`
  and `ACTIVITY_DOCK_SHEET_INSET_CLASS_NAME`.

### Settings that are off

When **Chat agent activity** or **Terminal agent activity** is off, the card
does not render and no activity atom is read. Saved pane state is kept. The
effects that closed a disabled persisted right-panel surface
(`ChatView.tsx:2041-2074`) are deleted.

## 3. Profiler, crash, and trace coverage

- **#188:** web-only. It adds no process, RPC method, worktree path, binary
  mode, service, or profiler event.
- **#192:** it adds `tracing::warn!` and `tracing::info!` at the observer's
  operational boundaries, logged once per executable and reason, with no
  content beyond what is already logged.
  - It changes preparation budgets, but no process is spawned differently. The
    helper is still registered and attributed through the existing
    `SystemCodexHelperLauncher` and `process_attribution` path.
  - It adds no RPC method. `terminal.open` stays out of `is_long_running`,
    because the new cap is under the 10 s hang threshold.
  - Its documentation goes in the fallback paragraph of
    `docs/architecture/activity-observation.md`.

## 4. Ownership

**Granted:**

- the `ChatView.tsx` activity ranges;
- `components/activity/ActivityPaneBinding.tsx`;
- `e2e/support/activity-events.ts`;
- `rightPanelLayout.ts`;
- `provider_terminal/codex.rs`, `provider_terminal/supervisor.rs`, and
  `terminal/manager.rs`.

`ChatView.hooks.test.tsx` edits are limited to what renames force; new cases go
in `ChatView.activityPane.test.tsx`.

**Still needed:**

- **`apps/desktop/e2e/support/test-project.ts`.** The Codex fixture's terminal
  mode prints nothing and handles no SIGWINCH, so the coordinator's "test the
  TUI redraws" cannot be observed with it. The change is small: in the
  fixture's non-app-server branch, write `\x1b[2J\x1b[Hfixture-tui
  <cols>x<rows>` at start and on `process.stdout.on("resize")`. The packaged
  test then asserts that the xterm buffer shows the new size after each toggle.
  Without this grant, the terminal toggle is proven only by xterm and PTY row
  counts, not by a TUI redraw.
- **`apps/server/tests/provider_terminal_supervisor.rs`**, for the two Rust
  integration tests. It is the same crate as the granted files and its
  existing Codex harness.
