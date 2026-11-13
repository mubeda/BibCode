# Design: server-side terminal screen state and attach checkpoints (#350)

Status: **Draft for review** (Codex and the advisor). No code is written until both approve.
Source: GitHub issue #350 (crate spike and the 16 review findings, which are binding), this
batch's `spec.md` (R5 to R11, D2, D3), and the current code on `main`. Findings are cited as F1 to F16 in the issue's order. Every choice this
document makes that the issue left open is marked **(agent's call)** and listed in section 6.

## 1. Problem, goal and scope

When a window attaches again, the server sends its raw byte history (5,000 lines or 1 MiB,
`apps/server/src/terminal/history.rs`). Once the program's last full paint has left that
history, the rebuilt screen is missing cells, the alternate screen and the input modes. A
program that repaints by cell diff then shows missing characters. Bytes written at an older
size also land wrongly at the current size (the issue's comment: 4 stale rows).

Goal: the server keeps an emulated screen per session. A client that asks for one gets an
attach **checkpoint**: bytes that rebuild both screens, the modes and a bounded scrollback,
followed by live output from an exact sequence. This works for every program and on Windows
servers. Old clients and old servers keep today's behaviour.

Out of scope: images (no image addon is installed in the panel); kitty keyboard flags;
DCS/OSC strings longer than 64 KiB (handled by an explicit fallback, D5); search parity (there
is no SearchAddon). OSC 8 links and supported colour state are **not** dropped (F9): they are
kept in the checkpoint (D1, section 3). If a state the checkpoint cannot carry has been
emitted, that session falls back to today's raw history until the state is cleared (D3).

## 2. Decisions

### D1. Crate, vendoring and module layout (F1, F9, F13)

Decision: use avt 0.20.0, vendored under `third_party/avt` and wired through the existing
`[patch.crates-io]` table in the root `Cargo.toml`, with an `UPSTREAM.md`. That is how
`third_party/portable-pty` is already vendored. The vendored copy carries three local changes,
each listed in `UPSTREAM.md`:

1. its width function is replaced by a generated table (D2);
2. a zero-width character joins the previous cell instead of taking a column (F9);
3. the pen gains a hyperlink id (OSC 8), an underline style and an underline colour (`58;2`,
   `58;5`). The spike found that these three were its only cell differences (stream 4).

The wrapper lives in a new `apps/server/src/terminal/screen.rs`. The spike sized it at about
260 lines; with the pen and hyperlink serialization, expect about 400. It holds the parts
listed in the issue: side tracker, hold-back feed, dump rewrite, SGR intensity fix, scrollback
serializer. Its public surface:

```rust
pub(crate) struct TerminalScreen { /* avt::Vt, side tracker, held-back tail, validity */ }

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ScreenInvalid { UpstreamLag, UnsupportedState, TailOverflow, OverBudget }

pub(crate) struct TerminalCheckpoint { pub data: String, pub scrollback_lines: usize }

impl TerminalScreen {
    pub(crate) fn new(cols: u16, rows: u16) -> Self;
    /// Exactly the redacted bytes that were published, in publication order.
    pub(crate) fn feed(&mut self, data: &str);
    /// Every authoritative size transition, and nothing else (D4).
    pub(crate) fn resize(&mut self, cols: u16, rows: u16);
    /// `terminal.clear` (a full reset, like the RIS clients apply today).
    pub(crate) fn reset(&mut self);
    pub(crate) fn invalidate(&mut self, reason: ScreenInvalid);
    pub(crate) fn validity(&self) -> Result<(), ScreenInvalid>;
    /// Bytes that rebuild this state after a client's RIS, at most `max_bytes` (D6).
    pub(crate) fn checkpoint(&self, max_bytes: usize) -> Result<TerminalCheckpoint, ScreenInvalid>;
}
```

`TerminalScreen` has no handle to the PTY and no reply channel. The emulator cannot answer a
query (F4).

Alternatives:
- vt100 0.18.1: no reflow, no DEC line drawing, no custom tab stops, no insert mode, no `?7`,
  saved cursor not exposed (F1, F9).
- alacritty_terminal 0.26.0: keeps the inactive grid, tab stops, scroll region and charset
  private; 38 dependencies (F1).
- `@xterm/headless` in the server: needs a Node runtime, which AGENTS.md forbids.
- Using avt from crates.io unpatched: its widths do not match the client (D2) and it would
  lose OSC 8 (F9).

### D2. Width parity (F9, F13)

Decision **(agent's call)**: the client loads `@xterm/addon-unicode11` 0.9.0 and sets
`terminal.unicode.activeVersion = "11"`. The server's vendored avt uses a width table
generated from that addon's own tables by a script in `scripts/`. A test fails when the
checked-in table differs from a fresh generation. Zero-width and combining marks join the
previous cell. VS16 and ZWJ are handled as the addon handles them: each code point is measured
on its own, with no grapheme clustering. A wide character at the right margin wraps and leaves
the last cell blank, as xterm does.

The `unicode` API is marked experimental in the 6.0.0 typings. Phase 2's harness settles
whether `allowProposedApi: true` is needed; Phase 5 sets it in the panel if so. Unicode 11 is
active in every terminal, whatever the server **(agent's call)**: one width mode per client.

Gate: the differential harness (section 4) must show zero differing cells for a width corpus:
every code point the table lists, emoji with and without VS16, ZWJ sequences, combining
stacks, and wide characters at column `cols - 1`.

An old client never gets a checkpoint, because it never asks for one (D6). A new client asks
only after the unicode11 addon is active. The request value names the width mode
(`"checkpoint-unicode11"`), so a future width change is a new value, not a silent mismatch.

Alternatives:
- `@xterm/addon-unicode-graphemes` 0.4.0: lost because the server would also have to
  reproduce its grapheme clustering, which avt does not do, and the addon is younger.
- Leaving the client on Unicode 6 and forking the server to Unicode 6: lost because programs
  such as the Claude CLI assume modern widths, so Unicode 6 is already wrong for them on screen.

### D3. Upstream loss and unsupported state (F8, F9)

Decision: the emulator is fed after redaction, in the publisher, so it never sees private
values. The PTY output broadcast (capacity 1024, `pty.rs:598`) can still report `Lagged`
(`manager.rs:2930`, `:2956`, `:2994`). On every upstream `Lagged`, the publisher calls
`invalidate(UpstreamLag)` under the same locks as `publish_output_gap`.

An invalid screen keeps being fed. It becomes valid again at `terminal.clear`, at a new
generation (restart), or when the stream itself carries a full reset (RIS), as `spec.md` R6
requires. RIS counts only if the harness case `ris-revalidates` shows that RIS followed by the
rest of the stream equals a fresh terminal fed the same rest, side-tracked state included;
if it does not, RIS is dropped from the list and the spec's R6 is amended.

`UnsupportedState` follows one rule: a setter that xterm 6.0.0 implements and the checkpoint
cannot carry invalidates the screen; a sequence xterm ignores does not. It clears at the same
points.

While the screen is invalid, an attach that asked for a checkpoint gets today's raw history,
marked `historyFormat: "raw"`, plus the existing SIGCONT recovery where it applies (D11).

A viewer that merely falls behind (the attachment's own `Lagged`, `manager.rs:4829`) is
downstream loss. It gets a fresh checkpoint through the existing resync and never invalidates
the screen.

Alternative: feed the emulator in the PTY reader thread, before the broadcast, which would be
lossless. It lost because the reader runs before redaction, so the emulator and its
checkpoints would hold private values that clients must never receive. Moving redaction into
the reader is a separate, larger change.

### D4. Where the screen is fed and resized; lock budget (F7, F11, F12, F14, F15)

Decision **(agent's call)**: feed synchronously, under the publication lock and the session
lock, in the same block that already pushes history and advances the sequence. That block is
`publish_output_chunk` (`manager.rs:3383`) and `record_private_output` (`:1973`). Order: feed
the screen, push the history, then `advance()`. A checkpoint read under the same session lock
then matches `session.sequence` exactly (F15).

Why not the batched alternative from F12? The spike measured 67–71 MiB/s with the wrapper. The
publisher already coalesces up to 64 KiB (`manager.rs:76`), so one feed takes at most about
1 ms, and a typical TUI frame of a few KB takes well under 0.1 ms. A batched design needs a
second journal, a parser-progress fence and trimming rules: more code and more failure modes
for no measured need.

Budget, from `spec.md` R11, watched by the profiler (D12) and recorded by a release-mode
measurement in Phase 3 (a recorded number, not a pass or fail test) at 120 × 40 with 5,000
scrollback lines and at 1000 × 500: checkpoint under 20 ms (spike: 8.8 ms), feed at least 50 MiB/s
(at most about 1.3 ms per 64 KiB chunk), retained memory under 16 MiB per session. If Phase 3
measures worse, implementation stops and this decision reopens.

Authoritative size transitions call `screen.resize` under the same locks, right where
`session.cols` and `session.rows` change: `resize_acknowledging` (`manager.rs:3952`) and
`publish_kept_size` (`:3993`, F7). A new session or restart creates a new screen at its open
size (`:2743`).

Ownership-only changes (`:3605`, `:3625`, `:4051`, `:4084`), same-size acknowledgements
(`:3938`) and refused-size answers (`:3924`) do not touch the screen. The invariant is that
the screen's size always equals `session.cols × session.rows`. A debug assertion checks it at
every checkpoint.

Lifecycle: `terminal.clear` (`:4087`) calls `reset()`, since clients already apply a RIS on
`cleared`. Exit keeps the screen; the final drain and the redaction tail flush still feed it.
Restart builds a fresh screen with the new generation (F15).

### D5. Checkpoint contents and restoration order (F1, F2, F3)

The checkpoint assumes the client has just written RIS (`writeTerminalBuffer` does,
`terminalReplyGuard.ts:51`) and has resized xterm to the snapshot's `size`. It writes, in this
order (the spike's order, which passed):

1. Title.
2. Palette and dynamic colours (OSC 4, 10, 11, 12), from the side tracker; global, so order
   does not matter.
3. Scrollback, oldest first, painted on the normal screen and scrolled off.
4. Normal screen paint.
5. Tab stops (TBC, then HTS).
6. Normal-screen saved cursor: with margins and origin mode if it was saved in origin mode; a
   pending wrap is restored by reprinting the last cell.
7. If the alternate screen is active: CUP to the normal cursor, `SGR 0`, `?1047h` (not
   `?1049h`, which would overwrite the saved cursor), the alternate paint, then the alternate
   saved cursor.
8. DECSTBM.
9. `?6h`, only right before the final CUP, because `?6` homes the cursor (F3).
10. Final CUP. A pending wrap is restored by reprint before `?7l`.
11. Pen SGR, including underline style and colour, and the open OSC 8 link if any.
12. Then: `?25l` if hidden, charsets (G0–G3 and GL), IRM, `?7l`, LNM, DECCKM.
13. Side-tracked modes: `?2004h`, mouse modes, `?1006h`, `?1004h`, keypad, cursor style.
14. `?2026h` if a synchronized-output transaction is open (xterm 6.0.0 supports the mode).
15. The raw held-back tail.

Paint (steps 3, 4 and 7): runs carry their SGR and OSC 8 open and close. A soft-wrapped row is
printed to the right margin and continues without CR LF, so xterm marks the next row as
wrapped (F10). Hard line ends use CR LF.

Held-back tail (F2): the wrapper's scanner keeps the bytes of an escape or control string that
has not finished (CSI, OSC, DCS, ESC with intermediates, an open ST) as raw text. It is capped
at 64 KiB. Past the cap, the wrapper drops the held bytes and reports `TailOverflow` until the
parser is back in ground state; checkpoints in that window fall back to raw (D3). Nothing waits
forever.

### D6. Wire contract and per-attachment format (F6, F14, F16)

| Item | Contract |
|---|---|
| Capability | `terminalScreenCheckpoint: true` in `lifecycle.rs` capabilities; `Schema.Boolean` with default `false` in `packages/contracts/src/environment.ts`. |
| Request | `terminal.attach` payload gains optional `historyFormat: "raw" \| "checkpoint-unicode11"`. Rust: a `history_format` field on `TerminalAttachPayload` (`server_terminal.rs:1679`, no `deny_unknown_fields`, so an old server ignores it) and `TerminalAttachInput` (`model.rs:124`). TypeScript: `TerminalAttachInput` (`contracts/src/terminal.ts:117`). Absent means `"raw"`. |
| Response | `TerminalSessionSnapshot` (`model.rs:228`, `terminal.ts:270`) gains optional `historyFormat: "raw" \| "checkpoint"`. When it is `"checkpoint"`, `history` holds checkpoint bytes and `size` is the checkpoint's size (same lock). Absent means raw, so a new client works unchanged with an old server (F16). |
| Who asks | A client sends `"checkpoint-unicode11"` only when the capability is advertised, size ownership is on (xterm then takes the server's size, `ThreadTerminalPanel.tsx:1905`), and the unicode11 addon is active (**agent's call**). |
| Selection | `TerminalAttachment` stores its format. Attach (`manager.rs:3655`) and lag resync (`:4952`) build the history in that format under the publication and session locks. `Started` and `Restarted` are shared events (`:2860`). For a checkpoint attachment, `deliver` (`:4862`) re-reads them under the same locks, like a resync, and sets `next_sequence` to that read's sequence. `terminal.open` answers (`:2325`, `:2809`) stay raw. |
| Size bound | `CHECKPOINT_MAX_BYTES = 4 MiB` (**agent's call**). Over the bound, the oldest scrollback lines are dropped first. If the two screens alone exceed it, `checkpoint` returns `OverBudget` and the answer is raw. The existing resync capacity wait (`server_terminal.rs:966`) still applies. |
| Windows | `LossyReplay`, `has_discarded_prefix` and `lossy_replay` are `#[cfg(unix)]` today (`history.rs:13–27`, `:203–218`). Phase 4 removes that gate; only the SIGCONT call stays Unix-only. |
| New RPC | `terminal.readCheckpoint` `{threadId, terminalId, historyFormat}` returns a snapshot (checkpoint or raw) at an exact `sequence`. Registered through the `rpc/session.rs` unary wrapper; not long-running. Gated by the same capability. Used only by D8. |

Mixed windows each get their own format over the same canonical state. A legacy client is
never sent checkpoint bytes, so the 512 KiB legacy cut (`terminalTranscript.ts:43`) can never
cut a checkpoint (F6).

Checkpoint replay itself never sends a resize. The client's existing claim rules decide, and a
web test proves it (F14).

### D7. Startup-query handoff (F4)

Decision **(agent's call)**: a checkpoint snapshot always has `firstAttachmentGrant: false`
(`spec.md` R8). The handoff is separate, as F4 asks. Until the generation's grant is used, the
side tracker records each query the program emits (DA, DSR, DECRQM, DECRQSS, OSC colour
queries), up to 16 queries and 1 KiB, in order. The one attach that wins the grant
(`manager.rs:3590`) receives them in a new optional snapshot field `startupQueries`. The
client writes them after the checkpoint through the existing grant path
(`replay(bytes, true)`), so its owning xterm answers them once. Answers use the restored
state: a cursor report gives the current position, as a late answer would today. A raw-format
attach keeps today's grant behaviour unchanged.

Emulator side: `TerminalScreen` has no PTY handle, and the vendored avt's query answers (if
any) are discarded.

Client side: checkpoint replays use the ordinary replay path, so `acceptInput()` is false while
they parse (`terminalReplyGuard.ts:128`). A web test restores `?1004h` and asserts that the
`CSI I` or `CSI O` xterm emits is dropped. If xterm emits it after the parse callback, the
guard's window is extended by one frame for checkpoint replays (decided by that test).

Tests cover DA, DSR, DECRQM, DECRQSS, OSC 10/11 colour queries and the focus report: the
startup counts match today and live counts are unchanged.

### D8. Client storage, second renderer and refresh (F5, F13)

Decision **(agent's call)**: an ordered journal, with a single-flight refetch when it overflows.
`terminalTranscriptRuntime.ts` keeps, per process, a `base` (the checkpoint string, its size
and its sequence) and a `journal` (every accepted `delta` and `resized` since the base, each
with its sequence).

The journal is capped at 1 MiB. Hydrating a renderer (`attachRenderer`, `:375`) sends
`reset(base, baseSize)` and then the journal entries in order to that sink only. Output that
arrived before a resize is therefore laid out at its own size (F5).

Journal `resized` entries are replayed geometry only. They resize xterm and update the mirror
scale, but they skip the ownership logic in `applySize` (`ThreadTerminalPanel.tsx:1910–1914`),
which could otherwise send a claim (F14).

When the journal overflows, or when the base is a raw answer to a checkpoint request that has
since seen eviction or a resize:
1. The runtime drops the base. A checkpoint is never replayed with an evicted middle.
2. It calls `terminal.readCheckpoint` once (single flight) and keeps journaling events.
3. It applies the answer at sequence S only if the answer's generation matches the current
   process. It never waits: sequences are spent on events this client never receives, such as
   other windows' acknowledgements (`manager.rs:4912–4920`).
4. It keeps the journal entries after S, raises the applied floor to S and clears the sequence
   source, so every stream's later events at or below S are dropped.

If 2 MiB pile up while the request is in flight, it is cancelled and retried once; after that
the runtime falls back to today's raw tail. `cleared`, `restarted`, a close or the last
renderer detaching cancel it. Renderers that attach meanwhile are hydrated when it lands. A
raw snapshot to a raw request keeps today's path. The live renderer is never affected.

Alternative: replace the base after every size change by refetching. It lost because each
resize would cost an RPC and a large checkpoint, and two windows resize often (#348).

### D9. Scrollback depth, soft wraps and memory (F10, F11)

Decision **(agent's call)**: the scrollback limit is
`min(5_000, (1_600_000 − 2 × cols × rows) / cols)` lines, never below 0, so at most about 1.6
million cells per session. That is the full 5,000 lines at typical widths: at 120 × 40 it
allows more than 13,000 lines and is capped at 5,000. At the largest permitted size,
1000 × 500, it allows 600 lines.

The spike measured 13.3 MiB at 120 × 40 with 5,000 lines (inferred: about 23 bytes per cell).
The bound is therefore about 37 MiB per session at the maximum size and about 13 MiB typically.

The limit is recomputed on every resize. Exited sessions keep their screen while they keep
their history. Depth matches today's line limit, soft wraps are kept (D5), and raw history is
unchanged, so nothing MCP could read before is lost.

### D10. Raw history stays (F16)

`TerminalHistory` and its limits stay as they are. MCP `status`, the escape-end probe and
`read` (`mcp/tools/terminals.rs:133`, `:308`, `:522`) keep reading raw bytes with their epochs,
cursors and dropped-window reports. It also serves raw attaches.

### D11. SIGCONT after this change

`resume_after_lossy_attach` (`manager.rs:1880`) is sent only when an attach was answered in raw
format (an old client, or an invalid or over-budget screen) and the history is lossy (R10). Checkpoint attaches send none. Windows has no signal, as today.

### D12. Observability (AGENTS.md profiler coverage)

All payloads are content-free: no bytes, titles, URIs or paths.

| Name | Kind | Payload | When |
|---|---|---|---|
| `terminal.checkpoint` | event | requested format, answered format, fallback reason (`upstream-lag`, `unsupported-state`, `tail-overflow`, `over-budget`), bytes, scrollback lines, cells, serialize µs | every attach, resync and `readCheckpoint` |
| `terminal.screen-invalidated` | event | reason | each change to invalid |
| `terminal.screen-slow` | finding | operation (`feed` or `checkpoint`), µs, cols × rows bucket | over the D4 budget |

All are emitted through `profiler::emit` and `profiler::record_finding`, behind
`profiler::is_enabled()`. `terminal.readCheckpoint` is timed by the RPC wrapper. Documented in
`docs/skills/bibcode-profiler/references/events.md` and `findings.md`, and in the Profiler and
terminal sections of `docs/architecture/overview.md`.

## 3. Supported-state matrix

Kept = carried in the checkpoint. Side = carried by the side tracker. Fallback = while this
state is in use, the screen is invalid and attaches get raw history (D3). Every test named
here is a case in the differential harness unless marked Rust.

| State | How | Proving test case |
|---|---|---|
| Cells, SGR (bold, faint, italic, inverse, 16, 256 and colon/semicolon truecolour) | Kept | `paint-sgr`, `sgr-intensity` |
| Underline style and underline colour (`4:x`, `58`) | Kept (pen patch) | `underline-style-colour` |
| OSC 8 hyperlinks | Kept (pen patch) | `osc8-runs`, `osc8-open-at-checkpoint` |
| Palette and dynamic colours (OSC 4, 10–12, 104, 110–112) | Side | `palette-restore` |
| Title (OSC 0, 2) | Side | `title` |
| Both screens, active buffer | Kept | `alt-active`, `alt-exit-after-checkpoint` |
| Saved cursors (both screens), with origin and margins | Kept | `decsc-restore-normal`, `decsc-restore-alt` |
| Scroll region, origin mode | Kept | `decstbm-origin-continuation` |
| Pending wrap (cursor and saved) | Kept by reprint | `pending-wrap-final`, `pending-wrap-saved` |
| Tab stops | Kept | `custom-tabs` |
| Charsets G0–G3, GL, DEC line drawing | Kept | `charsets-line-drawing` |
| IRM, DECAWM, LNM, DECCKM, cursor visibility | Kept | `modes-basic` |
| Bracketed paste, mouse modes, SGR mouse, focus, keypad, cursor style | Side | `modes-side-tracked`, web `focus-report-dropped` |
| Synchronized output `?2026` | Side | `sync-open-at-checkpoint` |
| Unfinished escape or control string ≤ 64 KiB | Held-back tail | `split-csi`, `split-osc`, `split-dcs`, `split-st`, `split-charset` at every byte offset |
| Unfinished string > 64 KiB | Fallback (`TailOverflow`) | Rust `tail_overflow_falls_back_then_recovers` |
| Soft wraps in scrollback and on screen | Kept | `softwrap-scrollback`, `softwrap-resize-reflow` |
| Scrollback depth (D9) | Kept | Rust `scrollback_limit_tracks_cells_budget` |
| Widths (unicode11) | Kept | `widths-corpus`, `wide-right-margin` |
| Any other OSC or DCS setter that changes later rendering (for example DECSCA, DECSLRM, `?69`) | Fallback (`UnsupportedState`) | Rust `unsupported_setter_falls_back` |
| Images (sixel, iTerm2, kitty) | Out of scope (no addon; bytes pass through as today) | none |
| Kitty keyboard flags | Out of scope | none |

## 4. Test strategy

Fixtures (F13): a Rust test module in `screen.rs` runs deterministic generated streams through
the real `TerminalScreen`. At each chosen boundary k (every byte for the split cases, 64 seeded
random offsets otherwise) it writes the checkpoint taken after byte k, with the stream, into
`apps/web/src/components/__fixtures__/terminal-checkpoints/*.json`.
`BIBCODE_UPDATE_SCREEN_FIXTURES=1` rewrites the files; without it the test fails on stale ones.

Differential harness: `apps/web/src/components/terminalCheckpoint.xterm.test.ts`, using
`@xterm/headless` 6.0.0 and `@xterm/addon-unicode11` 0.9.0 as devDependencies. For each
fixture and boundary:
- terminal A takes the whole stream;
- terminal B takes RIS, then the checkpoint, then the rest of the stream;
- the harness compares every cell of both buffers (characters, width, attributes, link),
  cursors, `modes`, the active buffer and the `isWrapped` flags; zero differences are allowed;
- each stream ends with a probe tail: DECRC, TAB, IND at the margin, `?1049l` or `?1047l`, and
  printing at the pending wrap, so a state that looks right but is wrong shows up (F1, F3).

Named cases, from F13 and the matrix: saved-cursor restoration; tabs and charsets;
normal-screen return; OSC 8; wrap and reflow; synchronized-output completion; startup and live
reply counts; clear, restart and exit; stale generations; upstream and downstream lag; refresh
during output; the legacy cut; requested size → output → kept size → output → attach (F7);
output → resize → output → second renderer (F5); the Unicode corpus (D2).

| Layer | Where | Command |
|---|---|---|
| Rust unit: screen, widths, fixtures | `apps/server/src/terminal/screen.rs` | `cargo test -p bibcode-server terminal::screen` |
| Rust manager: feed and resize order, kept size, lag invalidation, clear, restart, exit, per-attachment format, grant, SIGCONT narrowing, lock benchmark | `apps/server/src/terminal/manager.rs` tests | `cargo test -p bibcode-server terminal::manager` |
| Rust RPC: payload, `readCheckpoint`, capability | `apps/server/src/production/server_terminal.rs`, `lifecycle.rs` tests | `cargo test -p bibcode-server production::server_terminal`, then `cargo test -p bibcode-server lifecycle` |
| Contracts | `packages/contracts` tests | in `packages/contracts`: `node ../../scripts/run-local-vp.mjs test run` |
| Client runtime: journal, refetch fence, cancellation, raw path unchanged | `packages/client-runtime/src/state/terminalTranscriptRuntime.test.ts` | in `packages/client-runtime`: `node ../../scripts/run-local-vp.mjs test run src/state/terminalTranscriptRuntime.test.ts` |
| Web: differential harness, reply guard, panel request field, no resize on replay | `apps/web/src/components/*.test.ts(x)` | in `apps/web`: `node ../../scripts/run-local-vp.mjs test run --project unit src/components/terminalCheckpoint.xterm.test.ts src/components/terminalReplyGuard.test.ts src/components/ThreadTerminalPanel.interactions.test.tsx` |
| Packaged E2E: a cell-diff fixture program, re-attach after the history is evicted, and a resize while the window is away (the 4-stale-rows case), with the Profiler on | `apps/desktop/e2e/specs/terminal-checkpoint.e2e.ts` | `vp run test:ui:desktop:build`, then `vp run test:ui:desktop` |

Gates before the PR is done: `vp check`, `vp run typecheck`, `cargo fmt --all --check`, and
Clippy for the server with warnings denied. Also the Linux Docker lab and the Windows VM run of
the E2E spec (ConPTY output).

## 5. Phases

Every phase lands in the same pull request. Phases 0 to 4 do not touch
`ThreadTerminalPanel.tsx` and can run in parallel with other lanes. Phases 5 and 6 come after
those lanes.

| Phase | Goal | Files | Proof | Must not touch |
|---|---|---|---|---|
| 0. Vendored avt and widths | avt 0.20.0 under `third_party/avt` with the width table, zero-width join and pen patch; width table generator | `third_party/avt/**`, root `Cargo.toml`, `Cargo.lock`, `scripts/generate-unicode11-widths.mjs` and its test, `apps/web/package.json` (devDependency on the addon, used as the table source) | Rust width tests; the table-is-current test; licence recorded in `UPSTREAM.md` (Apache-2.0) | `apps/server/src/terminal/manager.rs`, any web component |
| 1. Wrapper and serializer | `screen.rs` per D1 and D5, fixture generator | `apps/server/src/terminal/screen.rs`, `mod.rs`, fixtures | Rust continuation tests at every split; fixtures generated | manager, wire |
| 2. Differential gate | Harness and corpus green against xterm | `terminalCheckpoint.xterm.test.ts`, `apps/web/package.json` devDependencies (`@xterm/headless`, unicode11) | Zero differing cells for all cases | `ThreadTerminalPanel.tsx` |
| 3. Shadow integration | Feed and resize under the locks, reset, invalidate, profiler; nothing on the wire | `manager.rs`, profiler docs | Rust manager tests including F7 and lag; benchmark within the D4 budget; a recorded real Claude CLI stream (synthetic prompts only) causes no `terminal.screen-invalidated` | `server_terminal.rs`, contracts |
| 4. Wire and server selection | Capability, request and response fields, per-attachment format, `readCheckpoint`, startup handoff, SIGCONT narrowing, `LossyReplay` un-gated | `model.rs`, `history.rs`, `server_terminal.rs`, `lifecycle.rs`, `rpc.ts`, `contracts/src/terminal.ts`, `environment.ts`, `docs/architecture/rpc-and-orchestration.md` | Rust and contract tests; an old-client payload still gets raw; a new client on an old server decodes raw | web components |
| 5. Client | unicode11 in the panel, the request field, journal and refetch, guard and replay | `ThreadTerminalPanel.tsx`, `terminalReplyGuard.ts`, `client-runtime` state and RPC, their tests | Web and runtime tests; React review (`vercel-react-best-practices`) and `UI.md` review | server |
| 6. End to end and docs | Packaged spec on macOS, the Linux lab and the Windows VM; overview, runbooks, changelog | `apps/desktop/e2e/specs/terminal-checkpoint.e2e.ts`, `docs/architecture/overview.md`, `docs/testing/*`, `CHANGELOG.md` | The spec passes with the Profiler on; profiler data analysed | none beyond the listed files |

**The user-visible fix arrives with Phase 5**, on top of Phase 4: the first time a client asks
for and replays checkpoints. That fixes missing characters and stale rows after a re-attach
for any program, including on Windows servers. Phase 0 must land before Phase 5, so that
widths match before any checkpoint reaches a client.

## 6. Risks, open questions and agent's calls

Top risks:
1. Width or grapheme mismatch with xterm on input outside the corpus. Mitigation: the D2 corpus
   gate and the generated table, which follows the addon rather than `unicode-width`.
2. Lock hold time and memory across many sessions, exited ones included (D4, D9). Mitigation:
   the profiler finding and the Phase 3 benchmark; stop and replan if they fail.
3. Upstream `Lagged` under bursts now that publication does more work (D3). The fallback is
   safe but loses the fix for that session until a clear or restart.
4. Patch maintenance on the vendored avt (three local changes).
5. The ConPTY stream, the real Claude CLI stream, invalid UTF-8 handling (the PTY decoder
   already splits at UTF-8 boundaries, `pty.rs:1038`) and resizing on the alternate screen are
   not tested by the spike. Phase 6 runs the real streams.

Open questions: (1) whether avt 0.20.0 exposes the per-line wrapped flag, a changeable
scrollback limit, and the saved-cursor and charset state, or needs more vendored patches
(settled in Phase 0; each patch is listed in `UPSTREAM.md`); (2) whether xterm emits the focus
report synchronously while parsing `?1004h` (Phase 5 test, D7); (3) whether `terminal.unicode`
needs `allowProposedApi` (Phase 2 harness, D2).

Agent's calls:
- AC1: vendor avt with a `[patch]` (D1). AC2: extend its pen for OSC 8 and underline style and
  colour instead of falling back (D1, F9).
- AC3: unicode11 over unicode-graphemes, active in every terminal; the server table is
  generated from the addon (D2).
- AC4: the request value `"checkpoint-unicode11"` names the width mode; the response field is
  `historyFormat` (D6).
- AC5: keep feeding an invalid screen (D3). AC6: feed under the locks, not batched (D4).
- AC7: the `UnsupportedState` rule, implemented-by-xterm setters only (D3).
- AC8: a 4 MiB checkpoint bound with scrollback trimmed first, then `OverBudget` (D6).
- AC9: `Started` and `Restarted` are re-read per checkpoint attachment in `deliver` (D6).
- AC10: a `startupQueries` field of at most 16 queries and 1 KiB as the separate handoff (D7).
- AC11: only size-ownership clients with unicode11 active ask for checkpoints (D6).
- AC12: a 1 MiB client journal, geometry-only replay of journal sizes, and a
  `terminal.readCheckpoint` refetch that raises the applied floor instead of waiting (D8).
- AC13: a scrollback budget of 1.6 million cells, at most 5,000 lines (D9).
- AC14: profiler names and payloads (D12). AC15: `terminal.clear` fully resets the screen (D4).
- AC16: the exited-mode suffix stays on checkpoint replays; it reads the checkpoint's `?1047h`.
- AC17: `terminal.open` answers stay raw (D6).
