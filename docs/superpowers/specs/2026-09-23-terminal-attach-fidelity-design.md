# Terminal size and reply ownership across attached clients

Status: **Approved by the user on 2026-09-23** (recommended options).

## Problem and evidence

User report: Claude Code in a BiBCode terminal on a remote Fedora server
(reached from the macOS client; the server runs inside the AppImage desktop on
that host) shows stale fragments at line starts, the input box border drawn
through text, and the right-aligned "Your login expires…" notice duplicated on
two rows and cut at the right edge. The missing custom status line had a
separate cause (AppImage `PYTHONHOME`) fixed in v0.6.2.

Reproduced against the dev server with Playwright (scripts in the session
scratchpad, not in the repository):

- **D1 — size contention between clients (explains the screenshot).** Two
  windows attached to one terminal at different sizes: `TerminalManager::resize`
  (`apps/server/src/terminal/manager.rs`) applies the last request to the PTY
  and tells no one. The program redraws for the last resizer; every other
  window renders that output at its own width. Reproduced with tmux (window A
  151x50, window B attaches at 91x42: A shows two status lines, the right-aligned
  one cut at column 91, and stale rows) and with real Claude Code 2.1.281 in an
  isolated config directory (narrow window A, wider window B attaches: A shows
  Claude's full-width separators and diff bars wrapped onto two rows). The
  corruption persists until the affected window happens to resize again.
  A window attaches only while the terminal tab is foregrounded and the
  document is visible (`ThreadTerminalPanel` `shouldRender`), so the desktop
  window on the Fedora host counts whenever it shows the same terminal.
- **D2 — replayed history re-answers terminal queries.** Every attach or
  remount creates a fresh xterm and writes `\x1bc` plus the raw transcript
  (`writeTerminalBuffer`). xterm answers every DA1/DA2/DSR/OSC 10/11 query in
  that history and `onData` forwards the replies to the PTY as input: captured
  as `terminal.writeInput sequence 0 "\x1b[?1;2c\x1b[>0;276;0c\x1b]10;rgb:…"`
  right after `terminal.attach`, visible at a bash prompt as `1;2c0;276;0c`,
  "command not found", and merged into the next typed command. Each attached
  window also answers live queries, so N windows send N replies. The server
  already answers OSC 10/11/12 and `DSR ?996` synchronously (`terminal/osc.rs`)
  but still forwards the query bytes, so xterm answers them a second time.
- **Retracted:** an earlier "remount replay diverges" result was a probe
  artifact (tmux renames its tab, so a name-based click opened another
  terminal). Selecting the tab by index, single-client remount, page reload,
  histories past the server's 5000-line and the client's 512 KiB limits, and a
  viewport shrink are all correct with tmux and with real Claude Code. An
  Ink-style stand-in that ignores reflow breaks on shrink, but real Claude Code
  redraws cleanly, so that is the stand-in's limitation.

## Ownership and scope

- `packages/contracts` (schema only): the applied PTY size in
  `TerminalSessionSnapshot`, a `resized` attach-stream event, an optional
  claim token on `TerminalResizeInput`, and a capability flag so a newer
  client degrades to today's behaviour against an older server.
- `apps/server` `terminal::manager`: owns the applied size and publishes it;
  no new process, persistence, or trust boundary.
- `packages/client-runtime` `terminalTranscriptRuntime`: carries the PTY size
  to renderers in stream order with output.
- `apps/web` `ThreadTerminalPanel`: decides when a window claims the size,
  renders non-owning windows at the PTY size, and owns the reply guard.

The PTY size stays a property of the server session; clients never infer it.

## Alternatives and decisions

### Size policy (D1)

1. **Latest active window owns the size; others mirror it (recommended).**
   A window claims the size when it attaches while focused, when the user
   focuses, clicks, or types into its terminal while its fitted size differs
   from the PTY size, and when its own container resizes while it already
   owns the size. Every other window sizes its xterm to the PTY's cols/rows
   instead of fitting its container, so its rendering always matches what the
   program drew (clipped or letterboxed, never garbled), with a short
   explanation and a "Fit to this window" action. Mirrors never send resizes
   from layout changes, which rules out resize ping-pong between windows.
   This is tmux's `window-size latest` and Orca's "driver owns the size" model.
   It suits the reported setup: one window in use, one idle window on the
   server's own desktop.
2. **Smallest attached window wins (tmux `window-size smallest`).** No
   ownership state, deterministic, but an idle small window (or a phone)
   shrinks the window you are using.
3. **Broadcast only.** Publish the size and let non-last-resizers mirror, but
   never reclaim on interaction. The smallest change, but a window stays at
   another window's size until you resize it by hand.

### Reply ownership (D2)

- **Replay guard (required):** while a renderer writes a reset snapshot,
  automatic replies produced by parsing it are dropped (guard from the
  `write` call until xterm's write callback). Keystrokes during the few
  milliseconds of a replay are also dropped, which is accepted.
- **One live reply owner:** only the window that owns the size answers live
  queries; mirrors swallow them with xterm parser hooks (CSI `c`, `>c`, `n`,
  `?n`, `$p`, `?$p`, DCS `$q`, OSC 4/10/11/12 `?`). Filtering `onData` by reply
  shape was rejected as fragile.
- **Server-answered queries:** every renderer swallows OSC 10/11/12 queries
  and `CSI ? 996 n`, because `terminal/osc.rs` already replies synchronously
  (and inside the provider's detection window). Stripping them from the
  forwarded stream instead would change transcript bytes, so it was rejected.

### Replay model

- **Keep raw-transcript replay (recommended).** Measured correct for single
  clients once D1/D2 are fixed.
- **Server-side VT emulator snapshots (Orca).** Orca keeps an
  `@xterm/headless` model per PTY and attaches with a serialized screen, modes,
  size, and sequence number. BiBCode would need a Rust VT crate
  (`alacritty_terminal`, `vt100`, `wezterm-term`) with xterm-compatible
  serialization and Unicode 11 widths. That is a large change with width
  fidelity risk and no demonstrated failure today, so it is deferred unless a
  residual appears after this change.

## Protocol and behaviour (recommended option)

- `TerminalSessionSnapshot` gains `cols`, `rows`, `sizeClaim` (nullable).
- New attach-stream event `resized { cols, rows, sizeClaim }`, published by
  `TerminalManager::resize` under the generation's publication lock after the
  PTY accepts the size, so it is ordered before any output the program writes
  in response to `SIGWINCH`. It is also published when the size is unchanged
  but the claim changed, so the previous owner stops answering queries.
- `TerminalResizeInput` gains optional `sizeClaim` (random per renderer mount).
- The client sends its fitted `cols`/`rows` on `terminal.open` and
  `terminal.attach` (the schemas already allow them; the panel omits them
  today), so a new PTY spawns at the client's size instead of 120x30 followed
  by a resize 30 ms later.
- Capability `terminalSizeOwnership` in the environment descriptor; without it
  the client keeps today's last-writer-wins behaviour.
- Owner-lost handling: when the owning window detaches, the PTY keeps its
  size; the next window to satisfy a claim trigger takes over.

### Refinements after the round-1 review (2026-09-23)

The review and host tests found gaps in the rules above. These refinements
close them; they keep the approved intent (the window in use owns the size,
nothing is ever garbled, exactly one window answers queries).

- **A terminal always has a reply owner.** A renderer sends its `sizeClaim`
  with `terminal.attach`. If the session has no claim (a new PTY, a restart, a
  legacy resize, or after the owner left), the server assigns the attaching
  renderer's claim atomically and the snapshot already names it, so the first
  window answers startup queries (for example ConPTY's and PowerShell's
  cursor-position request on Windows) with no round trip. When the attachment
  that holds the claim ends (renderer detach or connection close), the server
  clears the claim and publishes `resized` with `sizeClaim: null`; a renderer
  that sees a null claim claims immediately (last one wins). While the claim
  is null every renderer answers queries, as today.
- **Older clients never see the new event.** `resized` is only sent on attach
  streams whose attach request carried a `sizeClaim`; `subscribeTerminalEvents`
  never carries it. New snapshot fields stay optional, so older clients ignore
  them. The applied size travels as one optional `size { cols, rows,
  sizeClaim }` object so a half size cannot exist.
- **Interaction claims whenever this window does not own the size** (focus,
  click, keypress), not only when the sizes differ, with at most one claim in
  flight per renderer. Two people typing in two windows therefore hand the
  size back and forth on each alternation, like tmux's `window-size latest`;
  a single user never sees it.
- **The mirror notice appears only when this window does not own the size and
  its fitted size differs from the PTY size**, so a lone window or an equal
  size never shows it and a claim in flight never flashes it.
- **Color queries are swallowed only when the server answers them.** The
  snapshot says whether the session's OSC color responder is active; without
  it the owner lets xterm answer OSC 10/11/12. `CSI ? 996 n` stays swallowed
  (xterm does not implement it).
- **Opening never fails for lack of geometry.** When the destination cannot be
  measured yet, the terminal opens without dimensions (server default) and the
  renderer's first claim resizes it.

### Rulings after the round-2 review (2026-09-23)

- **Startup queries emitted before any window attaches are answered once.**
  A PTY can start before its first renderer attaches (center and script
  terminals, terminal-mode agents started by the server). Queries it emits in
  that gap (for example Windows PowerShell's startup cursor-position request)
  sit in the history, and nobody has answered them. The server marks the
  attach snapshot of the first claim-carrying attachment of each PTY process
  generation; that renderer (which owns the size by the atomic assignment)
  replays the history with replies allowed. Every later replay keeps the
  guard. This matches the behaviour before this change for the first window
  and removes the repeated junk on every later attach.
- **Terminal creation keeps `terminal.open`.** The workspace admission lease
  and workspace-loss fence that `terminal.open` takes stay the only creation
  path; the right panel does not create terminals through attach. A view that
  does not exist yet (new right-panel, center, or script terminal) opens
  without dimensions and its first claim resizes the PTY.
- **A claim's in-flight slot clears when its resize request completes**
  (success or failure), not only on an echo, so a resize the server accepts
  without publishing (exited session, departed claim) cannot leave it pending.
- **The mirror notice never hides terminal rows permanently** and can be
  dismissed until the next size change.
- **Typography (corrected 2026-09-24):** UI.md requires fixing typography
  violations in any file a change touches, so the terminal panel's tab labels
  move to `text-xs`; an earlier ruling that reverted this as scope creep was
  wrong.
- **OSC responder granularity:** the snapshot flag is true when the session's
  responder is active; the web always sets all three colors, so per-color
  flags are not needed today.

## Failure, reconnect, concurrency

- A reconnecting window receives the size in its snapshot and starts as a
  mirror unless it is focused (then it claims).
- Stale claims from a renderer that already unmounted are harmless: its
  events are ignored by the renderer generation checks that exist today.
- Two users typing in two windows at once hand the size back and forth on
  each alternation (see the refinements above); one claim at most is in
  flight per renderer.
- Duplicate or reordered `resized` events are idempotent (last one wins in
  stream order).

## Validation

- Server: `resize` publishes `resized` in order with output; claim-only
  changes publish; the snapshot carries the size.
- Web: open and attach send the fitted size, and the PTY spawns at it.
- Client runtime: resize signals reach renderers in stream order.
- Web (Vitest): mirror sizing, each claim trigger, no resize from a mirror's
  layout change, replay guard drops replies, mirrors swallow live replies,
  OSC 10/11/12 and `?996` never answered by xterm.
- Playwright: the two-window oracle (tmux and real Claude Code) shows no
  corruption in either window; a bash prompt receives no junk after attach,
  remount, or reload; single-window remount/reload oracles stay green.
- Living docs: the terminal section of `docs/architecture/overview.md` and
  the affected `docs/testing/` runbooks.

## Residuals

- Untested: silent `Lagged` drops on slow remote links.
- After a page load the first fit runs before the bundled terminal font is
  ready, so the terminal uses fallback metrics (for example 146 columns where
  151 fit) and wider letter spacing until something refits. Cosmetic; noted,
  not fixed here.
- Transcript bytes emitted at an older width replay at the current width;
  programs that redraw on resize (Claude Code, tmux) are unaffected.

## Question for the user

Was the same terminal open in two windows when the corruption appeared (for
example the BiBCode desktop window on the Fedora machine and the macOS
client, or a browser tab)?
