# Design: server-side terminal screen state and attach checkpoints (#350)

Status: **Draft for review, revision 2** (Codex and the advisor). No code is written until both approve.
Sources:
- GitHub issue #350: the crate spike and its 16 review findings, cited as F1 to F16; they are binding;
- this folder's `README.md`: the facts established since revision 1;
- `reviews/design-review-1.md`: the first review, cited as R1#1 to R1#13;
- the current code on `main`.

Every choice this document makes that the issue left open is marked **(agent's call)** and listed in section 6. The other issues' plan (`../2026-11-13-issue-batch-348-358/`) owns the client's Unicode 11 widths (its R5).

## Changes since revision 1

| Review finding | Where it is answered |
|---|---|
| R1#1: the refetch could drop events a live renderer needs | D8 (the cache fence is separate from live delivery, with a worked example) |
| R1#2: the startup-query replay wrote RIS again | D7 (a separately guarded write inside one replay, before the held tail) |
| R1#3: lifecycle re-reads were not generation-fenced; `Started` is not in the stream union | D6 (one catch-up operation, its lock order, `Started`, the restart grant) |
| R1#4 to R1#7: serializer fidelity (saved origin, inactive saved state and charsets, preceding-character state, contextual joining and the margin) | D5 (the harness decides the order and must cover these sequences), D2 (the server side of widths and joining) |
| R1#8: RIS and clear do not reset every tracked state | D3 (no RIS rule; validity per state) |
| R1#9: memory beyond cells; lock time is not throughput | D9 (budget per structure, behaviour at exhaustion, recorded measurement) |
| R1#10: snapshot bytes are budgeted only on the resync path | D6 (one snapshot rule for every delivery path) |
| R1#11 to R1#13 | Fixed in the other issues' spec (R1, R35, R12), not here |
| Upstream loss (README) | D3 (no `UpstreamLag` invalidation) |
| avt 0.20.0 API facts (README) | D1 |
| Real CLI captures (open question) | Section 4, fixture hygiene |

## 1. Problem, goal and scope

When a window attaches again, the server sends its raw byte history (5,000 lines or 1 MiB, `apps/server/src/terminal/history.rs`). Once the program's last full paint has left that history, the rebuilt screen is missing cells, the alternate screen and the input modes. A program that repaints by cell diff then shows missing characters. Bytes written at an older size also land wrongly at the current size (the issue's comment: 4 stale rows).

Goal: the server keeps an emulated screen per session. A client that asks for one gets an attach **checkpoint**: bytes that rebuild both screens, the modes and a bounded scrollback, followed by live output from an exact sequence. This works for every program and on Windows servers. Old clients and old servers keep today's behaviour.

Out of scope: images (no image addon is installed in the panel); kitty keyboard flags; search parity (there is no SearchAddon). OSC 8 links and supported colour state are kept (F9); a state the checkpoint cannot carry makes that session fall back to raw history (D3).

## 2. Decisions

### D1. Crate, vendoring and module layout (F1, F9, F13)

Decision: use avt 0.20.0, vendored under `third_party/avt` and wired through the existing `[patch.crates-io]` table in the root `Cargo.toml`, with an `UPSTREAM.md`, as `third_party/portable-pty` already is.

Facts from avt 0.20.0's source (README):
- the type is `avt::Terminal`;
- `Line::is_wrapped()` is public and means "this row continues onto the next row";
- the saved cursor and the character sets are private; the saved cursor holds no character set; there are two character-set slots;
- the scrollback limit is set at construction only (`with_scrollback`), with no setter;
- `dump()` omits scrollback and targets a fresh avt terminal, so it is not an xterm checkpoint.

So the vendored patch is larger than revision 1's three changes. **The patch list comes from the harness work** (README step 1): each change exists because a harness fixture failed without it, and `UPSTREAM.md` lists each one with that fixture's name. Known candidates:
- access to saved state for both buffers, with a saved character set;
- more character-set slots;
- the pen's hyperlink and underline style and colour;
- combined-cell text;
- xterm's right-margin behaviour (D2);
- a scrollback limit that can change.

The wrapper lives in a new `apps/server/src/terminal/screen.rs`. Its public surface:

```rust
pub(crate) struct TerminalScreen { /* avt::Terminal, side tracker, held tail, query record, fallback */ }

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ScreenFallback { UnsupportedState, TailOverflow, OverBudget }

pub(crate) struct TerminalCheckpoint {
    pub data: String,
    /// Byte range of `data` holding the recorded startup queries, before the held tail (D7).
    pub startup_queries: Option<std::ops::Range<usize>>,
    pub scrollback_lines: usize,
}

impl TerminalScreen {
    pub(crate) fn new(cols: u16, rows: u16) -> Self;
    /// Exactly the bytes that were published, in publication order (D3, D4).
    pub(crate) fn feed(&mut self, data: &str);
    /// Every authoritative size transition, and nothing else (D4).
    pub(crate) fn resize(&mut self, cols: u16, rows: u16);
    /// `terminal.clear` (D3).
    pub(crate) fn reset(&mut self);
    pub(crate) fn fallback(&self) -> Option<ScreenFallback>;
    /// Bytes that rebuild this state after a client's RIS, at most `max_bytes` (D6);
    /// `with_startup_queries` places the recorded queries before the held tail (D7).
    pub(crate) fn checkpoint(&self, max_bytes: usize, with_startup_queries: bool)
        -> Result<TerminalCheckpoint, ScreenFallback>;
}
```

`TerminalScreen` has no handle to the PTY and no reply channel, so it cannot answer a query (F4).

Alternatives:
- vt100 0.18.1: no reflow, no DEC line drawing, no custom tab stops, no insert mode, no `?7`, no exposed saved cursor (F1, F9);
- alacritty_terminal 0.26.0: keeps the inactive grid, tab stops, scroll region and charset private, and has 38 dependencies (F1);
- `@xterm/headless` in the server: needs a Node runtime, which AGENTS.md forbids.

### D2. Width parity, server side (F9, F13)

The client's Unicode 11 widths ship with the other issues' plan (its R5). This design keeps only the server side.

The vendored avt replaces its width function with a table generated from `@xterm/addon-unicode11` 0.9.0's own tables, by a script in `scripts/`. A test fails when the checked-in table differs from a fresh generation. Width alone is not enough (R1#7). The patch also ports:
- the provider's contextual joining: whether a mark joins depends on the preceding parser state, so `A ESC[31m U+0301 B` differs from `A U+0301 B`;
- xterm's right-margin behaviour, including auto-wrap off: with 4 columns, `ABC ESC[?7l 界` leaves `ABC`;
- wide-cell tails and control boundaries.

VS16 and ZWJ stay explicitly non-grapheme-based, as the addon is. The harness corpus (section 4) is the gate.

The attach request value names the width mode (`"checkpoint-unicode11"`, D6). A client asks for it only while Unicode 11 is active in its terminals, so a future width change is a new value, not a silent mismatch.

Alternative: unicode-graphemes on both sides. It lost because the server would have to reproduce grapheme clustering, and the client plan chose unicode11.

### D3. What the screen is fed, and when it falls back (F8, F9)

The screen is fed exactly the published bytes: the redacted output that `publish_output_chunk` and `record_private_output` publish (`apps/server/src/terminal/manager.rs`).

**Upstream loss needs no invalidation.** When the publisher falls behind the PTY broadcast (`Lagged`), `publish_output_gap` calls `redact_private_output_gap`. That publishes only what the redactor's `note_gap` returns (`[redacted]` when a prefix was withheld, otherwise nothing) through `record_private_output`; the lost bytes reach no attached window. A screen fed the same published bytes therefore equals a window that stayed attached, which is the goal. Invalidating it would make a re-attach worse than an attached window. Revision 1's `UpstreamLag` reason and its RIS rule are dropped: RIS does not reset xterm's stored title (R1#8), so it is no recovery boundary.

A checkpoint answer falls back to raw history (`historyFormat: "raw"`, plus the existing SIGCONT recovery where D11 allows) for three reasons only:

| Reason | Set when | Cleared when |
|---|---|---|
| `UnsupportedState` | The emulator saw a setter for a state the checkpoint cannot carry. Which states exist is decided by the harness: a setter xterm 6.0.0 implements that no passing fixture covers. A sequence xterm ignores sets nothing. | Each such state is tracked on its own. A flag clears when that state is set back to its default by a sequence the harness proves restores the default, or at `terminal.clear` or a restart (a new screen). |
| `TailOverflow` | The unfinished escape or control string exceeds 64 KiB (D5). | When the parser is back in its ground state. |
| `OverBudget` | One checkpoint answer exceeds `CHECKPOINT_MAX_BYTES` (D6), or a structure in D9 is full. | When a later checkpoint fits; for D9 structures, as D9 says. |

`terminal.clear` resets the screen like a fresh one at the same size, but keeps the side-tracked title, which xterm's RIS keeps (R1#8). Any other side state is kept or reset exactly as the harness case `clear-matches-ris` shows RIS does in an attached window.

### D4. Where the screen is fed and resized (F7, F11, F12, F14, F15)

Decision **(agent's call)**: feed synchronously, under the publication lock and the session lock, in the block that already pushes history and advances the sequence (`publish_output_chunk`, `record_private_output`). Order: feed the screen, push the history, then `advance()`. A checkpoint read under the session lock then matches `session.sequence` exactly (F15).

A redactor's withheld prefix is not published and not fed. A checkpoint never flushes the redactor.

Authoritative size transitions call `screen.resize` where `session.cols` and `session.rows` change: `resize_acknowledging` and `publish_kept_size` (F7). A new session or restart creates a new screen at its open size. Ownership-only changes, same-size acknowledgements and refused-size answers do not touch it. A debug assertion checks `screen size == session.cols × session.rows` at every checkpoint. Exit keeps the screen; the final drain and the redaction tail flush still feed it.

Why not batched parsing (F12)? It needs a second journal, a parser-progress fence and trimming rules. Whether synchronous parsing is cheap enough is the D9 measurement. If the measurement shows the publication lock held long enough to raise upstream lag, this decision reopens before any wire phase.

### D5. Checkpoint contents (F1, F2, F3)

The checkpoint assumes the client has just written RIS and resized xterm to the snapshot's `size`. **The restoration order is whatever passes the differential harness** (section 4). It is not written here in prose: two rounds on paper each produced new failing sequences (R1#4 to R1#7). The harness must cover at least:
- both screens, the active buffer, and the normal screen restored after leaving the alternate one;
- saved cursor and attributes for **both** buffers, whichever is active, including the saved character set. Fixtures: `ESC[?1047h ESC[3;4H ESC7 ESC[?1047l` then `ESC[?1047h ESC8 X` prints at row 3, column 4; `ESC(0 ESC7 ESC(B` then `ESC8q` prints `─` (R1#5);
- scroll region and origin mode restored both **on and off**. Fixture: `ESC[2;4r ESC[?6h ESC[2;2H ESC7 ESC[?6l ESC[1;1H`, then a checkpoint, then `X` prints on row 1 (R1#4);
- pending wrap, at the cursor and in saved state;
- the preceding-character state that `REP` and combining marks use. Fixture: `A`, checkpoint, `ESC[3b` yields `AAAA`; plus combining marks at printable-character cuts (R1#6);
- contextual joining and the right margin with auto-wrap on and off (R1#7, D2);
- tab stops, G0 to G3 and GL, IRM, DECAWM, LNM, DECCKM, cursor visibility and style;
- SGR including underline style and colour, OSC 8 runs, and a link open at the cut;
- title and palette (OSC 0, 2, 4, 10 to 12, 104, 110 to 112);
- bracketed paste, mouse modes, SGR mouse, focus reporting, keypad mode, and synchronized output open at the cut;
- soft-wrapped rows (printed to the margin without CR LF), scrollback, and reflow on a later resize.

Held-back tail (F2): the wrapper keeps the bytes of an escape or control string that has not finished (CSI, OSC, DCS, ESC with intermediates, an open ST) as raw text, and ends every checkpoint with them. It is capped at 64 KiB. Past the cap, the wrapper drops the held bytes and reports `TailOverflow` until the parser is back in ground state (D3). Nothing waits forever.

### D6. Wire contract, per-attachment format and the catch-up (F6, F11, F14, F16)

| Item | Contract |
|---|---|
| Capability | `terminalScreenCheckpoint: true` in `lifecycle.rs` and `production/control.rs`; `Schema.Boolean` with default `false` in `packages/contracts/src/environment.ts`. |
| Request | `terminal.attach` gains an optional `historyFormat: "raw" \| "checkpoint-unicode11"`. Rust: `TerminalAttachPayload` (no `deny_unknown_fields`, so an old server ignores it) and `TerminalAttachInput`. TypeScript: `TerminalAttachInput`. Absent means `"raw"`. |
| Response | `TerminalSessionSnapshot` gains optional `historyFormat: "raw" \| "checkpoint"` and `startupQueries: { start: number, end: number }` (D7). When the format is `"checkpoint"`, `history` holds checkpoint bytes and `size` is their size (same session lock). Absent means raw (F16). |
| Who asks | A client with the capability advertised, size ownership on, and Unicode 11 active (**agent's call**). |
| Selection | `TerminalAttachment` stores its format. Attach and lag resync build the history in that format. `terminal.open` answers stay raw. |
| New RPC | `terminal.readCheckpoint` `{threadId, terminalId, historyFormat}` returns a snapshot at an exact `sequence` and generation, registered through the `rpc/session.rs` unary wrapper and gated by the capability. Used only by D8. |
| Windows | `LossyReplay` and `lossy_replay` lose their `#[cfg(unix)]`; only the SIGCONT call stays Unix-only. |

**Catch-up for checkpoint attachments (R1#3).** Today `accept()` lets `Restarted` past its sequence filter. It resets `next_sequence` to the event's sequence, and `deliver` forwards the shared event's raw snapshot. Output events carry no generation (`model.rs`, `TerminalEvent::Output`), so a queued `Restarted(g2)` delivered while the session is already g3 would mix generations. `Started` is a `TerminalEvent` but not in `TerminalAttachStreamEvent` (`packages/contracts/src/terminal.ts`); a client cannot decode one.

For a checkpoint attachment, `accept()` turns a `Restarted` or `Started` of this terminal into one operation, `catch_up()`. Lock order and steps:
1. Take the key's operation lock (`inner.operations.for_key`), as `resync()` does today. Start, restart and close hold the same lock, so the generation cannot change while it is held.
2. Drain every queued event, as `resync()` does.
3. Find the current session; if it is absent, deliver `closed`. Take the session lock only to clone `session.generation`, then release it.
4. Take that generation's publication lock, with no session lock held, then the session lock (publication → session, the order publishers use). Recheck `Arc::ptr_eq(&session.generation, &captured)` and that the session is still registered; on a mismatch, deliver `closed`. Under the operation lock a mismatch can only mean removal.
5. Build the checkpoint and read `session.sequence` under these locks. Set `next_sequence` and `generation`, and deliver a plain `snapshot` item (not `resync`): the client treats it as a new process. Events queued after the read with a sequence at or below it are filtered as today.

Today's `resync()` takes operation → session; `catch_up()` takes operation → session (brief, released) → publication → session. Neither holds the session lock while waiting for a publication lock. Raw-format attachments keep today's `Restarted` path unchanged, and `Started` stays filtered for them as today.

Restart grant. Today a restart with surviving claimed streams marks the new generation's grant used (`first_attachment_grant_used = is_restart && claims non-empty`). For a session with at least one checkpoint attachment, the restart leaves the grant unused instead. The first `catch_up()` of the carried-over size owner wins it; with no carried-over owner, the first checkpoint `catch_up()` or claimed attach wins it, as at first attach. The winner's checkpoint carries the recorded startup queries (D7). Raw attachments never receive the grant through a restart, as today.

**Snapshot bytes on every path (R1#10).** Today `attach_item_value` counts only output bytes and `Resync` history. The capacity wait (`while resync && sender.capacity() < sender.max_capacity()`) applies only to batches with a `Resync`, so an `Event(Restarted)` snapshot bypasses both. New rule: every item that carries a snapshot is a heavy item, whatever its label: the initial response, `Resync`, the catch-up snapshot and a raw `Event(Restarted)`. For a heavy item:
- its `history` length counts toward the batch bytes;
- a heavy item ends its batch, so two snapshots never share one chunk;
- the capacity wait runs before sending any chunk that holds a heavy item.

`CHECKPOINT_MAX_BYTES = 4 MiB` (**agent's call**). Over the bound, the oldest scrollback lines are dropped first; if the two screens alone exceed it, the answer is raw with reason `OverBudget`. `terminal.readCheckpoint` answers obey the same bound.

### D7. Startup-query handoff (F4, R1#2)

A checkpoint snapshot always has `firstAttachmentGrant: false`. Until the generation's grant is used, the screen records each query the program emits (DA, DSR, DECRQM, DECRQSS, OSC colour queries), in order, at most **16 queries and 1 KiB**. On overflow it keeps the first 16 queries within 1 KiB and counts the rest as dropped (**agent's call**): programs wait on their first startup queries, and falling back to raw would bring back the missing cells.

For the attach or `catch_up()` that wins the grant (D6), `checkpoint(_, true)` places the recorded queries inside `data` after the restored state and **before** the held tail, and returns their byte range as `startupQueries`. Every other attachment gets the checkpoint without them.

Client side: one replay call writes the checkpoint after a single RIS, in three ordered writes, using the reply guard's existing write-callback scoping:
1. the bytes before `start`, with replies dropped;
2. the bytes `start..end`, with the grant scope active, so the owning xterm answers each query once against the restored cursor and modes;
3. the bytes from `end`, the held tail, with replies dropped.

No second RIS is written, so neither the restored screen nor the held parser prefix is lost. The runtime's existing once-only grant hand-off (`createResetSignalAndConsumeGrant`) delivers the range only to the renderer holding the winning claim. Any other renderer, and any later hydration, strips bytes `start..end`. Restoring `?1004h` reaches xterm's focus report synchronously, inside write 1 or 3, where replies are dropped. A web test asserts that it is dropped.

Tests: startup and live reply counts for DA, DSR (the answer reports the restored position), DECRQM, DECRQSS, OSC 10 and 11 and the focus report; a held tail across the query range; overflow at 17 queries and at 1 KiB.

### D8. Client cache, second renderer and refresh (F5, F13, R1#1)

Decision **(agent's call)**: option (b). The hydration cache has its own fence, and live delivery is never fenced by it.

Live delivery is today's path unchanged. `processEvent` applies output, sizes, clears and lifecycle (`exited`, `closed`) to every attached renderer and to the metadata, through its existing sequence rules.

The hydration cache, per process in `terminalTranscriptRuntime.ts`, holds:
- `base`: checkpoint bytes, size and sequence `B`;
- `journal`: every accepted `delta`, `resized` and `cleared` after `B`, each with its sequence, capped at 1 MiB;
- `stale`: true when the journal overflowed, or when the base is a raw answer that has since seen eviction or a resize.

A `cleared` resets the cache to an empty base at its sequence.

Hydrating a new renderer (`attachRenderer`) sends `reset(base, baseSize)` and then the journal in order, to that sink only. Journal `resized` entries are geometry only: they skip the panel's ownership logic. Then the renderer joins live fan-out with a per-renderer floor equal to the last sequence it was hydrated with. Live signals with a sequence at or below that floor are skipped for that renderer only, so output and size signals now carry their sequence. If `stale` is true, the renderer waits, `terminal.readCheckpoint` starts (single flight), and every waiting renderer is hydrated when it lands.

Request identity. Each request carries the process generation and a request serial. A response is used only if:
- its generation equals the current process;
- its serial is the latest;
- its `sequence` S is at or above the cache's last reset sequence.

A clear while a request is in flight therefore never lets an older read win: an answer read before the clear has S below the clear's sequence. If the clear's own event has not arrived yet when an answer with S above it lands, the cache later skips that `cleared`, since it is at or below S. Live renderers still apply it, as they must. A restart, a close or the last renderer detaching cancels the request. A cancelled refresh leaves `stale` set; the next renderer that attaches, or the next overflow, starts a new request with a new serial. If 2 MiB pile up while a request is in flight, it is cancelled and retried once; after that, hydration falls back to today's raw tail.

Worked example (the reviewer's). The live renderer has applied sequence 10. The cache is stale, and a new renderer is waiting. The response arrives with S = 13, covering output 11, resize 12 and exit 13.
- **Events 11 to 13 arrive before the response.** The live renderer applies output 11, resize 12 and exit 13 (metadata becomes `exited`) as today. The cache journals them. When the response lands, the cache sets `base = checkpoint(13)` and drops journal entries at or below 13. The waiting renderer is hydrated from it, with floor 13. Nothing is lost, and nothing reaches it twice.
- **The response arrives before events 11 to 13.** The waiting renderer is hydrated from `checkpoint(13)` with floor 13 and its exited replay suffix (the metadata still says running, so it gets none yet). When events 11 to 13 arrive, the live renderer applies all three. The new renderer skips 11 and 12, since they are at or below its floor. The metadata update for exit 13 reaches it through the metadata path, which is not sequence-filtered, so it shows "Process exited" once. The cache skips the three as covered by S.

S below the live applied sequence cannot happen within one generation: the server read happened after it published what the client applied.

Alternative (a), applying the fetched checkpoint and post-S journal atomically to every existing renderer. It lost because it rewrites live screens (selection and scroll position) for a cache refresh only new renderers need.

### D9. Scrollback, memory and lock-time measurement (F10, F11, R1#9)

The scrollback limit is `min(5_000, (1_600_000 − 2 × cols × rows) / cols)` lines, never below 0. avt sets it at construction only, so the vendored patch adds a setter applied on every resize (D1); if the harness work cannot add one, the screen is rebuilt at the new limit on resize (**agent's call**).

Each structure has a budget and a defined behaviour at exhaustion:

| Structure | Budget | At exhaustion |
|---|---|---|
| Cells (both grids plus scrollback) | 1.6 million cells | Scrollback shrinks by the formula above. |
| Combined text per cell (marks beyond the base character) | 32 code points per cell, 256 KiB per session | Further marks set `OverBudget` until clear or restart. |
| Hyperlink targets | Refcounted registry, freed when no cell or pen refers to a target; 2 KiB per URI, 4,096 targets, 1 MiB per session | A longer URI is kept as no link and sets `UnsupportedState` until it scrolls out of scrollback. A full registry sets `OverBudget` until entries are freed. |
| Side tracker (title, palette, modes) | Title 4 KiB, palette 256 entries | Longer titles are truncated as xterm truncates them; the harness case decides. |
| Held tail | 64 KiB | `TailOverflow` (D5). |
| Snapshot copies | One per attachment in flight (D6 backpressure), each at most 4 MiB, and at most 4 concurrent serializations per server, the others waiting on a semaphore (**agent's call**) | Callers wait; nothing is dropped. |

Exited sessions keep their screen while they keep their history. Depth matches today's line limit, soft wraps are kept, and raw history is unchanged, so nothing MCP could read before is lost.

**Measurement (recorded, not pass or fail).** A release-mode run records, at 120 × 40 with 5,000 scrollback lines and at 1000 × 500:
- publication-lock hold time per feed and per checkpoint (p50, p99, max);
- input latency from `terminal.write` to PTY write;
- upstream lag: `Lagged` count and gap events;
- retained memory per live and per exited session.

The run uses an output burst of at least 64 MiB with eight sessions, four of them exited, and concurrent attaches every 250 ms. The numbers are recorded in this folder. Increased upstream lag is a risk until measured, not an observed result. The spec's R11 targets (checkpoint under 20 ms, feed at least 50 MiB/s, under 16 MiB per session at 120 × 40) are compared against them in the plan review.

### D10. Raw history stays (F16)

`TerminalHistory` and its limits stay as they are. MCP `status`, the escape-end probe and `read` keep reading raw bytes with their epochs, cursors and dropped-window reports. It also serves raw attaches.

### D11. SIGCONT after this change

`resume_after_lossy_attach` is sent only when an attach was answered in raw format and the history is lossy. Checkpoint answers send none. Windows has no signal, as today.

### D12. Observability (AGENTS.md profiler coverage)

All payloads are content-free: no bytes, titles, URIs or paths.

| Name | Kind | Payload | When |
|---|---|---|---|
| `terminal.checkpoint` | event | path (`attach`, `resync`, `catch-up`, `read`), requested and answered format, fallback reason (`unsupported-state`, `tail-overflow`, `over-budget`), bytes, scrollback lines, cells, serialize µs, startup queries recorded and dropped | every checkpoint answer |
| `terminal.screen-fallback` | event | reason, set or cleared | each change |
| `terminal.screen-slow` | finding | operation (`feed`, `checkpoint`), µs, cols × rows bucket | over the measured budget |

All are emitted through `profiler::emit` and `profiler::record_finding`, behind `profiler::is_enabled()`. `terminal.readCheckpoint` is timed by the RPC wrapper. Documented in `docs/skills/bibcode-profiler/references/events.md` and `findings.md`, and in `docs/architecture/overview.md`.

## 3. Supported-state matrix

Kept = carried in the checkpoint, once a harness fixture for it passes. Fallback = while in use, checkpoint answers are raw (D3).

| State | How | Harness fixture |
|---|---|---|
| Cells, SGR (16, 256, colon and semicolon truecolour), underline style and colour | Kept | `paint-sgr`, `underline-style-colour` |
| OSC 8 links | Kept | `osc8-runs`, `osc8-open-at-cut` |
| Title, palette | Kept (side tracker) | `title`, `palette-restore`, `clear-matches-ris` |
| Both screens, saved state of both buffers with charset | Kept | `alt-inactive-saved` (R1#5), `charset-saved` (R1#5), `alt-exit-after-cut` |
| Scroll region, origin on and off | Kept | `origin-saved-then-off` (R1#4) |
| Pending wrap, preceding character, combining marks | Kept | `pending-wrap-*`, `rep-after-cut` (R1#6), `combining-at-cut` |
| Joining and right margin | Kept | `joining-after-sgr`, `wide-at-margin-nowrap` (R1#7) |
| Tabs, charsets, IRM, DECAWM, LNM, DECCKM, cursor | Kept | `custom-tabs`, `modes-basic` |
| Paste, mouse, focus, keypad, cursor style, `?2026` | Kept (side tracker) | `modes-side-tracked`, `sync-open-at-cut` |
| Unfinished string up to 64 KiB, and beyond | Held tail; beyond it, fallback | `split-*` at every byte; Rust `tail_overflow_recovers` |
| Soft wraps, scrollback, reflow | Kept | `softwrap-scrollback`, `softwrap-resize-reflow` |
| A setter xterm implements that no fixture covers | Fallback (`UnsupportedState`) | Rust `unsupported_setter_falls_back` |
| Images, kitty keyboard flags | Out of scope | none |

## 4. Test strategy

**Fixtures (F13).** A Rust test module in `screen.rs` runs streams through the real `TerminalScreen`: the reviewer's sequences above, named cases, and a seeded generator. At chosen cuts (every byte for split cases, 64 seeded offsets otherwise) it writes each checkpoint with its stream into `apps/web/src/components/__fixtures__/terminal-checkpoints/*.json`. `BIBCODE_UPDATE_SCREEN_FIXTURES=1` rewrites them; otherwise a stale fixture fails.

**Differential harness.** `apps/web/src/components/terminalCheckpoint.xterm.test.ts` uses `@xterm/headless` 6.0.0 with `@xterm/addon-unicode11` 0.9.0. Terminal A takes the whole stream. Terminal B takes RIS, then the checkpoint, then the rest. The harness compares:
- every cell of both buffers (characters, width, attributes, link);
- cursors, `modes`, the active buffer, the `isWrapped` flags, title and palette.

Each stream ends with a probe tail (DECRC on each buffer, TAB, IND at the margin, leaving the alternate screen, `REP`, and a print at the pending wrap), so a state that looks right but is wrong shows up.

**Fixture hygiene (AGENTS.md Sensitive Data).** Real CLI streams (the Claude CLI, ConPTY output) are captured only in a throwaway home directory, with a placeholder project `example-group/sample-project`, the user `Test User` and synthetic prompts. A sanitizer script then replaces every occurrence of the capture's home, temporary root, host name and user name with placeholders. It fails on any remaining match of the repository's sensitive-data guard (`vp test run scripts`) or gitleaks. Titles and OSC 8 targets are rewritten to placeholders. A captured fixture is committed only after the sanitizer passes and a reviewer has read it.

| Layer | Where | Command |
|---|---|---|
| Rust: screen, widths, fixtures | `apps/server/src/terminal/screen.rs` | `cargo test -p bibcode-server --lib -- terminal::screen` |
| Rust: feed and resize order, fallback, clear, restart, exit, catch-up fence and grant, heavy-item backpressure, SIGCONT | `manager.rs`, `server_terminal.rs` tests | `cargo test -p bibcode-server --lib -- terminal::manager production::server_terminal` |
| Contracts | `packages/contracts` | from `packages/contracts`: `node ../../scripts/run-local-vp.mjs test run` |
| Client runtime: cache fence, per-renderer floor, request identity, the D8 example both ways, clear during refresh | `terminalTranscriptRuntime.test.ts` | from `packages/client-runtime`: `node ../../scripts/run-local-vp.mjs test run src/state/terminalTranscriptRuntime.test.ts` |
| Web: harness, three-write replay, query range, focus report | `apps/web/src/components/*.test.ts(x)` | from `apps/web`: `vp test run --project unit src/components/terminalCheckpoint.xterm.test.ts src/components/terminalReplyGuard.test.ts` |
| Packaged end to end: cell-diff program, re-attach after eviction, resize while away, Profiler on | `apps/desktop/e2e/specs/terminal-checkpoint.e2e.ts` | `vp run test:ui:desktop:build`, then `vp run test:ui:desktop` |

## 5. Phases

| Phase | Goal | Proof |
|---|---|---|
| 0. Harness | Vendored avt, `screen.rs`, fixture generator, differential test with the reviewer's sequences failing first | Harness green; the patch list in `UPSTREAM.md` |
| 1. Shadow integration | Feed and resize under the locks, fallback, profiler; nothing on the wire | Rust manager tests; the D9 measurement recorded |
| 2. Wire and server | Capability, fields, catch-up, heavy items, `readCheckpoint`, grant, SIGCONT | Rust and contract tests; an old client still gets raw |
| 3. Client | Request field, three-write replay, cache fence and refresh | Runtime and web tests; React and `UI.md` reviews |
| 4. End to end and docs | Packaged spec on macOS, the Linux lab and the Windows VM; overview, runbooks, changelog | Spec green with the Profiler on |

The user-visible fix arrives with Phase 3, after the other issues' plan has shipped Unicode 11 widths. If the harness is still red after two fix rounds, the question goes to the user (README).

## 6. Risks, open questions and agent's calls

Risks:
1. The vendored patch grows beyond what can be maintained; the harness work measures its size.
2. Lock hold time and upstream lag under bursts (D9, measured before Phase 2).
3. Width and joining mismatch on input outside the corpus.
4. ConPTY output and the real Claude CLI stream: captured, sanitized fixtures (section 4).

Open questions:
1. Whether avt can take a scrollback-limit setter, or the screen is rebuilt on resize (D9).
2. Whether the reviewer accepts dropping the upstream-loss invalidation (D3, the README's "to confirm").

Agent's calls:
- AC1: vendor avt, with the patch list from the harness (D1).
- AC2: the request value `"checkpoint-unicode11"` names the width mode (D2, D6).
- AC3: three fallback reasons, each tracked and cleared per state (D3).
- AC4: synchronous feed under the locks, subject to the D9 measurement (D4).
- AC5: the harness decides the restoration order (D5).
- AC6: the catch-up operation and its lock order; the restart grant goes to the carried-over owner (D6).
- AC7: every snapshot-carrying item is a heavy item; 4 MiB bound (D6).
- AC8: keep the first 16 queries within 1 KiB; the three-write replay (D7).
- AC9: option (b), a separate cache fence with per-renderer floors and request identity by generation, serial and reset sequence (D8).
- AC10: the D9 budgets and the four-serialization semaphore.
- AC11: `terminal.clear` keeps exactly the side state RIS keeps, decided by `clear-matches-ris` (D3).
