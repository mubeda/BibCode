# Design: server-side terminal screen state and attach checkpoints (#350)

Status: **Draft for review, revision 4 (server protocol reviewed three times; D1, D9 pending the harness report; D8 settled by test)**. No code is written until Codex and the advisor approve.
Sources:

- GitHub issue #350: the crate spike and its 16 review findings, cited as F1 to F16; they are binding;
- this folder's `README.md`: the facts established since revision 1;
- `reviews/design-review-1.md` to `reviews/design-review-3.md`: the reviews, cited as R1#n, R2#n and R3#n;
- the current code on `main`.

Every choice this document makes that the issue left open is marked **(agent's call)** and listed in section 6. The other issues' plan (`../2026-11-13-issue-batch-348-358/`) owns the client's Unicode 11 widths (its R5).

## Changes since revision 3

| Review finding                                                                     | Where it is answered                                                     |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| R3#1: other operations consumed a pending checkpoint grant                         | D6, grant selection: one policy for every grant consumer, each listed    |
| R3#2: the initial snapshot outlived its permit                                     | D6, snapshot permits: the initial snapshot is moved into its first chunk |
| R3#3: no guard for the unary `readCheckpoint` answer                               | D6, snapshot permits: a response guard carried in the outbound frame     |
| R3#4: adoption lost the unchanged-terminal lag fast path                           | D6, step 2a                                                              |
| R3#5: incomplete lock inventory; operation-lock claims                             | D6, lock order: the reviewer's full table, and the qualified claims      |
| R3 open questions: a raw carried owner; a raw answer to the winner; "exactly once" | D6, grant selection                                                      |

## Changes since revision 2

| Review finding                                                | Where it is answered                                                                                                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R2#1: a delayed refetch left a missing middle                 | D8: the client checkpoint cache and journal are deleted; each joining renderer fetches its own checkpoint, and an overflowing pending buffer discards the response |
| R2#5: reset signals carried the size sequence                 | D8 rule (b): every ordered render operation carries its own event sequence                                                                                         |
| R2#6: hydration left owner and reply state stale              | D8 rule (c): ownership, reply claim, acknowledgement and status come from the fetched snapshot                                                                     |
| R2#7: an empty cache base after clear lost the title          | D8: no cache; a joining renderer's checkpoint is built by the server, which keeps the title (D3)                                                                   |
| R2#8: exit status depended on arrival order                   | D8 rule (c), with one exit presentation per generation                                                                                                             |
| R2#2: registry-lock inversion                                 | D6: `adopt_current_state` takes publication → registry read → session; every path that takes these locks is listed                                                 |
| R2#3: a restart missed through lag skipped the grant          | D6: one generation-transition function for lifecycle delivery and lag resync                                                                                       |
| R2#4: re-issued queries cleared continuation state            | D7: the whole guarded handoff must preserve continuation; the harness decides placement                                                                            |
| R2#9, R2#10: title truncation; links omitted at exhaustion    | D3: one rule, a fallback stays set until the unrepresentable state is provably gone                                                                                |
| R2#11: snapshot copies were not bounded                       | D6: a snapshot permit taken before construction and held until the client acknowledges the chunk                                                                   |
| R2 coverage: DECSCA, `?45`, palette in headless, UTF-16 range | D5, D7, section 4                                                                                                                                                  |
| Engine and memory budget                                      | D1, D9: pending the harness report                                                                                                                                 |

Revision 2's changes (answers to R1#1 to R1#10) are kept where this list does not replace them.

## 1. Problem, goal and scope

When a window attaches again, the server sends its raw byte history (5,000 lines or 1 MiB, `apps/server/src/terminal/history.rs`). Once the program's last full paint has left that history, the rebuilt screen is missing cells, the alternate screen and the input modes. A program that repaints by cell diff then shows missing characters. Bytes written at an older size also land wrongly at the current size (the issue's comment: 4 stale rows).

Goal: the server keeps an emulated screen per session. A client that asks for one gets an attach **checkpoint**: bytes that rebuild both screens, the modes and a bounded scrollback, followed by live output from an exact sequence. This works for every program and on Windows servers. Old clients and old servers keep today's behaviour.

Out of scope: images (no image addon is installed in the panel); kitty keyboard flags; search parity (there is no SearchAddon). OSC 8 links and supported colour state are kept (F9); a state the checkpoint cannot carry makes that session fall back to raw history (D3).

## 2. Decisions

### D1. Engine and vendoring (F1, F9, F13): **pending the harness report**

The harness work (README step 1) found that avt 0.20.0 and xterm 6.0.0 disagree in their basic model. It is building the engine on xterm's buffer model, with avt kept as a measured baseline. This design therefore does not specify the engine, its crate or its patches; the harness report will. Facts about avt 0.20.0 from its source, for the record:

- the type is `avt::Terminal`;
- `Line::is_wrapped()` is public and means "this row continues onto the next row";
- the saved cursor and the character sets are private;
- the scrollback limit is set at construction only;
- `dump()` omits scrollback.

Whatever the engine, it lives behind `apps/server/src/terminal/screen.rs`, and the rest of this design depends only on this surface:

```rust
pub(crate) struct TerminalScreen { /* engine, side tracker, held tail, query record, fallback */ }

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ScreenFallback { UnsupportedState, TailOverflow, OverBudget }

pub(crate) struct TerminalCheckpoint {
    pub data: String,
    /// UTF-16 code-unit range of `data` holding the re-issued startup queries (D7).
    pub startup_queries: Option<std::ops::Range<usize>>,
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
    /// Bytes that rebuild this state after a client's RIS, at most `max_bytes` (D6).
    pub(crate) fn checkpoint(&self, max_bytes: usize, with_startup_queries: bool)
        -> Result<TerminalCheckpoint, ScreenFallback>;
}
```

`TerminalScreen` has no handle to the PTY and no reply channel, so it cannot answer a query (F4).

### D2. Width parity, server side (F9, F13)

The client's Unicode 11 widths ship with the other issues' plan (its R5). This design keeps only the server side.

The engine uses a width table generated from `@xterm/addon-unicode11` 0.9.0's own tables, by a script in `scripts/`. A test fails when the checked-in table differs from a fresh generation. Width alone is not enough (R1#7). The engine also reproduces:

- the provider's contextual joining: whether a mark joins depends on the preceding parser state, so `A ESC[31m U+0301 B` differs from `A U+0301 B`;
- xterm's right-margin behaviour, including auto-wrap off: with 4 columns, `ABC ESC[?7l 界` leaves `ABC`;
- wide-cell tails and control boundaries.

VS16 and ZWJ stay explicitly non-grapheme-based, and ambiguous-width characters follow the provider's default-width policy. The harness corpus (section 4) is the gate.

The attach request value names the width mode (`"checkpoint-unicode11"`, D6). A client asks for it only while Unicode 11 is active in its terminals, so a future width change is a new value, not a silent mismatch.

Alternative: unicode-graphemes on both sides. It lost because the server would have to reproduce grapheme clustering, and the client plan chose unicode11.

### D3. What the screen is fed, and when it falls back (F8, F9)

The screen is fed exactly the published bytes: the redacted output that `publish_output_chunk` and `record_private_output` publish (`apps/server/src/terminal/manager.rs`).

**Upstream loss needs no invalidation.** When the publisher falls behind the PTY broadcast (`Lagged`), `publish_output_gap` calls `redact_private_output_gap`. That publishes only what the redactor's `note_gap` returns (`[redacted]` when a prefix was withheld, otherwise nothing) through `record_private_output`; the lost bytes reach no attached window. A screen fed the same published bytes therefore equals a window that stayed attached, which is the goal. Invalidating it would make a re-attach worse than an attached window. Revision 1's `UpstreamLag` reason and its RIS rule are dropped: RIS does not reset xterm's stored title (R1#8), so it is no recovery boundary.

A checkpoint answer falls back to raw history (`historyFormat: "raw"`, plus the existing SIGCONT recovery where D11 allows) for three reasons only. All three follow one rule (R2#9, R2#10): **a fallback reason stays set until the unrepresentable state is provably gone from every retained cell, the current pen and every saved pen, or until a restart.** Free capacity alone does not clear a reason, and neither does `terminal.clear`, because clear keeps side state such as the title.

| Reason             | Set when                                                                                                                                                                                                                                                                                                | Gone when                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UnsupportedState` | The screen saw a setter for a state the checkpoint cannot carry. Which states exist is decided by the harness: a setter xterm 6.0.0 implements that no passing fixture covers. A sequence xterm ignores sets nothing. A title or other side value too large to carry counts here; nothing is truncated. | Its holder is gone. For a cell attribute: no retained cell, current pen or saved pen carries it (a per-state count kept by the screen). For a side value: a supported setter replaced it. |
| `TailOverflow`     | The unfinished escape or control string exceeds 64 KiB (D5).                                                                                                                                                                                                                                            | The parser is back in its ground state.                                                                                                                                                   |
| `OverBudget`       | One checkpoint answer exceeds `CHECKPOINT_MAX_BYTES` (D6), or a structure the screen bounds is full and something could not be retained, such as a link target.                                                                                                                                         | Every cell, pen and saved pen that lost something is gone, counted as for `UnsupportedState`. A single oversized answer clears with the next answer that fits.                            |

`terminal.clear` resets the screen like RIS does in an attached xterm. It keeps the side-tracked title, which RIS keeps (R1#8); the harness case `clear-matches-ris` decides every other side value.

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
- soft-wrapped rows (printed to the margin without CR LF), scrollback, and reflow on a later resize;
- DECSCA protection on cells and pens. Fixture: `ESC[1"qA ESC[0"q`, checkpoint, then `CR ESC[?2K`; `A` survives the selective erase (R2);
- reverse wraparound `?45`. Fixture at four columns: `ABCDE ESC[?45h ESC[2;1H`, checkpoint, then `BS X` gives rows `ABCX` / `E` (R2);
- the whole startup-query handoff (D7). Fixture `with_startup_queries`: `ESC[6nA`, checkpoint with the re-issued query, then `ESC[3b` yields `AAAA` (R2#4).

Held-back tail (F2): the wrapper keeps the bytes of an escape or control string that has not finished (CSI, OSC, DCS, ESC with intermediates, an open ST) as raw text, and ends every checkpoint with them. It is capped at 64 KiB. Past the cap, the wrapper drops the held bytes and reports `TailOverflow` until the parser is back in ground state (D3). Nothing waits forever.

### D6. Wire contract, per-attachment format and the generation transition (F6, F11, F14, F16)

| Item       | Contract                                                                                                                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Capability | `terminalScreenCheckpoint: true` in `lifecycle.rs` and `production/control.rs`; `Schema.Boolean` with default `false` in `packages/contracts/src/environment.ts`.                                                                                                                    |
| Request    | `terminal.attach` gains an optional `historyFormat: "raw" \| "checkpoint-unicode11"`. Rust: `TerminalAttachPayload` (no `deny_unknown_fields`, so an old server ignores it) and `TerminalAttachInput`. TypeScript: `TerminalAttachInput`. Absent means `"raw"`.                      |
| Response   | `TerminalSessionSnapshot` gains optional `historyFormat: "raw" \| "checkpoint"` and `startupQueries: { start: number, end: number }` (D7). When the format is `"checkpoint"`, `history` holds checkpoint bytes and `size` is their size (same session lock). Absent means raw (F16). |
| Who asks   | A client with the capability advertised, size ownership on, and Unicode 11 active (**agent's call**).                                                                                                                                                                                |
| Selection  | `TerminalAttachment` stores its format. Attach and lag resync build the history in that format. `terminal.open` answers stay raw.                                                                                                                                                    |
| New RPC    | `terminal.readCheckpoint` `{threadId, terminalId, historyFormat}` returns a snapshot at an exact `sequence` and generation, registered through the `rpc/session.rs` unary wrapper and gated by the capability. Used only by D8.                                                      |
| Windows    | `LossyReplay` and `lossy_replay` lose their `#[cfg(unix)]`; only the SIGCONT call stays Unix-only.                                                                                                                                                                                   |

**One generation transition (R1#3, R2#3).** Today `accept()` lets `Restarted` past its sequence filter, resets `next_sequence` and forwards the shared event's raw snapshot (`manager.rs:4909`). Output events carry no generation, so a queued `Restarted(g2)` delivered while the session is already g3 would mix generations. `Started` is a `TerminalEvent` but not in `TerminalAttachStreamEvent` (`packages/contracts/src/terminal.ts:466`), so a client cannot decode one. A restart can also reach an attachment through lag: `recv()` sends `Lagged` to `resync()` (`manager.rs:4829`), which drains queued lifecycle events (`:4946`) and returns a new-process snapshot when the generation changed (`:4963`, `:4972`).

For a checkpoint attachment, both routes call one function, `adopt_current_state(reason)`, with reason `lifecycle` (a `Restarted` or `Started` of this terminal) or `lag`. Steps and locks: 0. Take a snapshot permit (below) before any lock, so waiting for one never holds a lock.

1. Take the key's operation lock (`inner.operations.for_key`), as `resync()` does. Start (`:2269`), restart (`:2177`) and a keyed close take the same lock, so they cannot change this terminal's generation while it is held. Thread-wide close (`:4130`) and shutdown (`:4549`) take no keyed operation lock: they can still remove the session, which is why steps 5 and 6 recheck it.
2. Drain every queued event.
   2a. Fast path, kept from `resync()` (`:4968`): for reason `lag`, read the session's generation and `sequence` under a brief session lock. If the generation is the attachment's own and the sequence equals `next_sequence`, release the permit and return nothing; no heavy item is built. The existing test `a_lag_caused_by_another_terminal_does_not_resync` covers it and gains a checkpoint-format case.
3. Read the registry (`inner.sessions.read()`) to clone the current session `Arc`, then release it. If the session is absent, deliver `closed`. Take the session lock only to clone `session.generation`, then release it.
4. Take that generation's publication lock, with no other lock than the operation lock held.
5. Read the registry again and check that the same session `Arc` is still registered, then release it. A mismatch means removal by a thread-wide close or shutdown: deliver `closed`.
6. Take the session lock. Check `Arc::ptr_eq(&session.generation, &captured)`.
7. Build the checkpoint and read `session.sequence`. If the generation differs from the attachment's last one, run the grant selection below. Set `next_sequence` and `generation`, and deliver a plain `snapshot` item (a new process) or a `resync` snapshot (the same process). Later events at or below that sequence are filtered as today.

Lag resync across a process change is the same function, so the existing test `a_resync_across_a_missed_restart_is_a_new_process` (`manager.rs` tests) is extended. It must assert the checkpoint format and that the carried-over owner receives the startup queries through a missed restart. Raw-format attachments keep today's `Restarted` and `resync()` paths, and `Started` stays filtered for them as today.

**Lock order.** Documented order: operation (O) → lifecycle (L) → publication (P) → registry (R, `inner.sessions`) → session (S). Rules: never wait for R or P while holding S; never wait for P while holding R. `adopt_current_state` holds only O while it waits for P, takes R only briefly, and takes S last. "Released" means the acquisition phases do not overlap. The inventory of existing paths (`manager.rs`), from the third review, verified against the cited lines:

| Existing path                                               | Actual order                                                                                                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Start/open and restart                                      | O → R released → S released; registration O → L → P → R released → S (`:2193–2236`, `:2278–2321`, `:2777–2838`)                              |
| Attach                                                      | initial L released; R released → S released → P → S; creation and restart use the paths above (`:3462–3475`, `:3484`, `:3537`, `:3556–3561`) |
| `mark_center_panel`                                         | S released → P → R released → S (`:2886–2895`)                                                                                               |
| `finalize_process_exit`                                     | P → R → S, then R and S released → S again (`:3306–3327`)                                                                                    |
| `release_size_claim`                                        | R released → S released → P → R released → S (`:3999–4016`)                                                                                  |
| Ordered input enqueue; unary write                          | P → S; unary write first captures the generation under a released S (`:453–455`, `:3816–3820`)                                               |
| Activity and agent-status publication                       | P → S (`:3194–3204`, `:3276–3281`)                                                                                                           |
| Output, tail flush and output-gap publication               | P → S (`:3389–3394`, `:3420–3424`, `:3435–3439`)                                                                                             |
| Resize, kept-size correction, clear                         | P → S, with released R or S lookups where needed (`:3881–3890`, `:3975–3977`, `:4088–4098`)                                                  |
| Close, `close_sessions`                                     | optional O → L → P → R write released → S; preliminary R and S captures released before P (`:4130–4155`, `:4343–4376`)                       |
| Worktree removal                                            | L → R → S, released before close is called (`:4171–4202`)                                                                                    |
| Identity capture, workspace quiescence                      | L → R released → S; finalization runs after L is released (`:4222–4234`, `:4254–4270`, `:4307–4314`)                                         |
| Thread listing, live counts and PIDs, metadata subscription | R → S (`:4440–4444`, `:4476–4480`, `:4491–4494`, `:4508–4511`)                                                                               |
| Shutdown                                                    | L → R lookup, then L → P → R write released → S through `close_sessions` (`:4549–4566`, `:4359–4376`)                                        |
| Existing resync                                             | O → R released → S released → R (`:4941–4959`)                                                                                               |
| Restart delivery, history read, input begin                 | R lookup released → S; restart delivery does **not** take O (`:4867–4869`, `:4891–4898`, `:4460–4461`, `:3688–3689`)                         |

No path takes these locks in reverse, and `adopt_current_state` adds none. The listing paths hold R while waiting for S, and a queued R writer waits behind them. `adopt_current_state` never holds S while reading R, so the inversion R2#2 describes cannot form.

**Grant selection (one policy for every consumer, R3#1).** The session's `first_attachment_grant_used: bool` becomes `startup_grant: StartupGrant`, with three states:

- `Open`: unused, as today;
- `Reserved(Option<claim>)`: pending for checkpoint delivery, optionally for one claim;
- `Used`.

One function, `Session::take_startup_grant(&mut self, claim: Option<&str>, delivers_handoff: bool) -> bool`, is the only writer. A consumer that delivers no startup handoff never takes a `Reserved` grant. Every place that writes the flag today goes through it:

| Today (`manager.rs`)                                                        | What it does now                                  | After the change                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New session, `first_attachment_grant_used: false` (`:2753`)                 | Starts unused                                     | `startup_grant = Open`                                                                                                                                                                                                                                                        |
| Restart, `= is_restart && claims non-empty` (`:2847`)                       | Marks the grant used when claimed streams survive | With a surviving checkpoint attachment: `Reserved(carried owner's claim)` if that owner is a checkpoint attachment, else `Reserved(None)`. Otherwise as today: `Used` when claims survive, else `Open`.                                                                       |
| Attach, `grant = size_owner.is_none() && !used; used = true` (`:3590–3592`) | Every claimed attach consumes it, granted or not  | `Open`: as today (granted only with no size owner, consumed either way). `Reserved(Some(c))`: taken only by an attach with claim `c` (a returning owner), else left reserved. `Reserved(None)`: taken by the first checkpoint attach. A raw attach never takes a reservation. |
| Resize to a refused size, `used \|= size_owner.is_some()` (`:3925`)         | A claim consumes it even when nothing changes     | `Open`: as today. `Reserved`: unchanged, since no handoff is delivered.                                                                                                                                                                                                       |
| Resize applying a claim, `used \|= size_owner.is_some()` (`:3937`)          | The same, for changed or unchanged sizes          | The same rule as `:3925`                                                                                                                                                                                                                                                      |
| `adopt_current_state` (new)                                                 | —                                                 | When adopting a new generation, it takes `Reserved(Some(c))` only for claim `c`, and `Reserved(None)` for the first adopter.                                                                                                                                                  |

Open questions from R3, settled:

- **A raw carried owner while a checkpoint mirror survives:** the reservation is `Reserved(None)`, so the first checkpoint adopter wins. The raw owner gets today's restart behaviour (no grant).
- **The winner's answer falls back to raw (D3):** the award stands, and the raw snapshot carries `firstAttachmentGrant: true` with raw history. That is today's grant replay, which writes RIS only once and is correct for raw.
- **"Exactly once"** means one server-side award per generation, taken before delivery as today (`:3592`, `:3655–3675`). Renderer execution is the client's once-only hand-off (D7). Two restarts queued before adoption give one handoff, for the generation adopted.

The winner's checkpoint carries the re-issued startup queries (D7).

**Snapshot bytes on every path (R1#10, R2#11, R3#2, R3#3).** Every item that carries a snapshot is a heavy item, whatever its label: the initial response, `resync`, an adopted snapshot, a `readCheckpoint` answer, and a raw `Event(Restarted)`. Today:

- construction comes before the capacity wait (`server_terminal.rs:951`, `:966`);
- the RPC pump frees channel capacity before awaiting the client's acknowledgement (`rpc/session.rs:1646`, `:1718`);
- `TerminalAttachment` keeps `initial` for its whole life (`manager.rs:4795–4804`; `server_terminal.rs:929–942` serializes it by reference).

New rules:

- **Permit before construction.** Before building a heavy item, the attachment or the handler takes a snapshot permit: one per attachment and at most eight per server (**agent's call**). For the initial snapshot, attach takes it before `current.snapshot()`.
- **The initial snapshot is moved, not kept.** `TerminalAttachment::initial` becomes `Option<TerminalSessionSnapshot>`. The stream takes it with `attachment.take_initial()` and serializes it by value into the first chunk, so no copy outlives the chunk.
- **Streams: the permit rides in the frame.** `RpcStreamChunk` gains an optional guard. The pump moves it into the `RpcOutboundFrame` it queues and drops it only after the client's acknowledgement for that chunk arrives.
- **Unary: a response guard in the outbound frame.** `RpcUnaryResult` already carries an `enqueue_guard` (`rpc/session.rs:257–279`), but that guard ends when the frame is queued, and unary requests have no acknowledgement (`:1363–1367`, `:1569–1602`, `:1960`). So `RpcUnaryResult` gains a second field, `response_guard: Option<Box<dyn Send>>`, set through a new constructor `RpcUnaryResult::held(result, guard)`. The unary dispatcher moves it into a new field of `RpcOutboundFrame` beside `_budget`. `RpcOutboundFrame::into_parts` returns it with the budget, so the writer holds it until the socket write completes, or until the frame is dropped with the connection. `terminal.readCheckpoint` returns its permit as that guard.
- A heavy item counts its `history` length toward the batch bytes and ends its batch.

So each attachment has at most one snapshot alive (its `String` and its JSON value), and the server at most eight, plus the raw `Event(Restarted)` clones below. One allocation stays outside the pool: tokio's broadcast clones a raw `Event(Restarted)` per receiver before any permit exists. It holds a new generation's history, which the raw history limits bound (`history.rs`); the permit is taken before it is serialized, and the clone is dropped right after. A checkpoint attachment drops it at once and adopts instead.

`CHECKPOINT_MAX_BYTES = 4 MiB` (**agent's call**). Over the bound, the oldest scrollback lines are dropped first; if the two screens alone exceed it, the answer is raw with reason `OverBudget`.

### D7. Startup-query handoff (F4, R1#2, R2#4)

A checkpoint snapshot always has `firstAttachmentGrant: false`. Until the generation's grant is used, the screen records each query the program emits (DA, DSR, DECRQM, DECRQSS, OSC colour queries), in order, at most **16 queries and 1 KiB**. On overflow it keeps the first 16 within 1 KiB and counts the rest as dropped (**agent's call**): programs wait on their first startup queries, and falling back to raw would bring back the missing cells.

The winner of the grant (D6) receives a checkpoint built with `with_startup_queries = true`. It holds the re-issued queries in a range `startupQueries` of `history`, given in **UTF-16 code units**, so the client can slice its JavaScript string directly. A test puts non-ASCII text before the range. Every other attachment gets the checkpoint without them.

Requirements only; the serializer harness decides where the range sits and what surrounds it:

1. The whole guarded handoff, including the re-issued queries, preserves continuation state. Fixture `with_startup_queries` (D5): `ESC[6nA`, a checkpoint with the re-issued DSR, then `ESC[3b` yields `AAAA`.
2. The client writes the checkpoint after a single RIS. It writes the range with the reply guard's existing grant scope (`terminalReplyGuard.ts` write-callback scoping), and everything else with replies dropped. No second RIS is written.
3. Only the renderer holding the winning claim gets the range, once (the runtime's existing once-only hand-off). Any other renderer strips it.
4. Restoring `?1004h` reaches xterm's focus report synchronously, outside the range, where it is dropped.

Tests: startup and live reply counts for DA, DSR, DECRQM, DECRQSS, OSC 10 and 11 and the focus report; overflow at 17 queries and at 1 KiB; a range after non-ASCII text.

### D8. A joining renderer fetches its own checkpoint (F5, F13, R2#1, R2#5 to R2#8)

**Fact (step 0).** A pane that returns opens a new server attach unless another viewport in the same client still holds that terminal's stream:

- Hiding the pane turns `attach` off (`ThreadTerminalPanel.tsx:1201`, `attach: shouldRender && canAttachTerminal && readyRenderer !== null`) and its cleanup clears the renderer's attachment input.
- The attach atom has idle TTL 0 (`packages/client-runtime/src/state/terminal.ts:200`), so the stream ends.
- The transcript runtime is reference-counted by live streams (`terminalAttachAdapter.ts:100–101`, `registry.acquire` and `registry.release`), so it is disposed with the last one.
- On return, the new renderer opens a new `terminal.attach` (`terminal.ts:179`), and the server's initial snapshot hydrates it.

Only when another viewport of the same terminal in this client keeps its stream open does the runtime persist. Its new stream's snapshot is then dropped as already applied (`terminalTranscriptRuntime.ts:232–262`), and the renderer hydrates from the client transcript through `attachRenderer` (`:376`). So the per-renderer fetch below is on the main path for every return of a single pane, and the second path covers split and multi-viewport layouts.

**Decision.** The client keeps no checkpoint, base, journal or cache of checkpoints. Revision 2's cache is deleted. A renderer that joins a terminal whose stream is in checkpoint format fetches its own checkpoint:

- from its own stream's initial snapshot when it opens the stream (every checkpoint renderer has a size claim and its own stream, `terminal.ts:294`). The runtime routes that snapshot to the renderer holding the stream's claim instead of dropping it;
- from `terminal.readCheckpoint` otherwise, which covers the refetch in rule (a).

Live renderers are unaffected: they keep consuming every event, as today. Four rules:

- **(a) Pending buffer.** From the moment the request is sent until its response is applied, the renderer's live events are held in a pending buffer of at most 1 MiB or 4,096 events (**agent's call**). When the response at sequence S lands, the renderer applies the checkpoint, then the buffered events above S, and joins live delivery. If the buffer overflows, the response is discarded and the renderer refetches; it is never applied with a gap. After three refetches the renderer falls back to today's raw tail for itself, and the client profiler records `terminal.hydration-fallback` (content-free: reason and attempt count) in the client collector's batch (`server.reportProfilerClientBatch`), which gains this kind.
- **(b) Sequence per operation.** Every ordered render operation carries its own event sequence: output, size, clear, restart and exit. Today the reset signal carries the size sequence (`terminalTranscriptRuntime.ts:155`, `:175`) even for a clear; size-position metadata stays separate from the delivery fence. A joining renderer's floor is S. It skips operations at or below S and applies everything above.
- **(c) State from the snapshot.** The joining renderer takes from the fetched snapshot, not from live metadata:
  - the owner and reply claim (`size.sizeClaim`, `size.replyClaim`);
  - its acknowledgement state (its claim is registered by its own attach);
  - its lifecycle status and exit code, so its replay applies the exited suffix exactly when the snapshot says exited.

  An exit is presented once per renderer and generation: the renderer records `presentedExit = generation` when it presents one, from its snapshot or from a later `exited` operation. A later exit notification for the same generation is not presented again.

- **(d) Raw answers.** The server may answer raw to a checkpoint request (D3), so the path is chosen per answer. A raw answer is replayed as today (RIS, history, exited suffix) with the same floor S and the same rules (a) to (c).

**This protocol is settled by a failing-first test, not by prose.** In `packages/client-runtime/src/state/terminalTranscriptRuntime.test.ts`, a scripted event stream drives the real runtime with a fake checkpoint. The fake holds all bytes since the last clear, plus size, owner and status at S, so equality is meaningful without an emulator. Response delay and event order are randomized with a seeded generator. The test asserts that the joining renderer's rendered byte stream, size, owner, reply claim and exit presentation equal those of a renderer that saw every event. Named cases, from R2:

- `delayed-response-overflow` (R2#1);
- `clear-after-join` (R2#5);
- `owner-moved-before-join` (R2#6);
- `clear-keeps-title` (R2#7);
- `exit-overtakes-response` and `response-overtakes-exit` (R2#8).

The test is written and run red before the runtime changes.

### D9. Scrollback and memory (F10, F11): **pending the harness report**

The engine's memory layout, scrollback limit and per-structure budgets come from the harness report (D1); this design states no numbers for them. What stays fixed:

- the scrollback depth matches today's line limit, and soft wraps are kept;
- raw history is unchanged, so nothing MCP could read before is lost;
- exited sessions keep their screen while they keep their history;
- a structure that fills sets `OverBudget` under D3's rule, never silently truncates;
- snapshot copies are bounded by D6's permits.

**Measurement (recorded, not pass or fail).** A release-mode run records, at 120 × 40 with 5,000 scrollback lines and at 1000 × 500:

- publication-lock hold time per feed and per checkpoint (p50, p99, max);
- input latency from `terminal.write` to PTY write;
- upstream lag: `Lagged` count and gap events;
- retained memory per live and per exited session.

The run uses an output burst of at least 64 MiB with eight sessions, four of them exited, and concurrent attaches every 250 ms. Increased upstream lag is a risk until measured. The spec's R11 targets are compared against the recorded numbers in the plan review.

### D10. Raw history stays (F16)

`TerminalHistory` and its limits stay as they are. MCP `status`, the escape-end probe and `read` keep reading raw bytes with their epochs, cursors and dropped-window reports. It also serves raw attaches.

### D11. SIGCONT after this change

`resume_after_lossy_attach` is sent only when an attach was answered in raw format and the history is lossy. Checkpoint answers send none. Windows has no signal, as today.

### D12. Observability (AGENTS.md profiler coverage)

All payloads are content-free: no bytes, titles, URIs or paths.

| Name                          | Kind                                              | Payload                                                                                                                                                                                                                              | When                                                    |
| ----------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `terminal.checkpoint`         | event                                             | path (`attach`, `resync`, `adopt`, `read`), requested and answered format, fallback reason (`unsupported-state`, `tail-overflow`, `over-budget`), bytes, scrollback lines, cells, serialize µs, startup queries recorded and dropped | every checkpoint answer                                 |
| `terminal.screen-fallback`    | event                                             | reason, set or cleared                                                                                                                                                                                                               | each change                                             |
| `terminal.hydration-fallback` | client event (client collector batch, a new kind) | reason (`pending-overflow`), attempts                                                                                                                                                                                                | a renderer falls back to raw after three refetches (D8) |
| `terminal.screen-slow`        | finding                                           | operation (`feed`, `checkpoint`), µs, cols × rows bucket                                                                                                                                                                             | over the measured budget                                |

All are emitted through `profiler::emit` and `profiler::record_finding`, behind `profiler::is_enabled()`. `terminal.readCheckpoint` is timed by the RPC wrapper. Documented in `docs/skills/bibcode-profiler/references/events.md` and `findings.md`, and in `docs/architecture/overview.md`.

## 3. Supported-state matrix

Kept = carried in the checkpoint, once a harness fixture for it passes. Fallback = while in use, checkpoint answers are raw (D3).

| State                                                                            | How                                             | Harness fixture                                                           |
| -------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| Cells, SGR (16, 256, colon and semicolon truecolour), underline style and colour | Kept                                            | `paint-sgr`, `underline-style-colour`                                     |
| OSC 8 links                                                                      | Kept                                            | `osc8-runs`, `osc8-open-at-cut`                                           |
| Title, palette                                                                   | Kept (side tracker)                             | `title`, `palette-restore`, `clear-matches-ris`                           |
| Both screens, saved state of both buffers with charset                           | Kept                                            | `alt-inactive-saved` (R1#5), `charset-saved` (R1#5), `alt-exit-after-cut` |
| Scroll region, origin on and off                                                 | Kept                                            | `origin-saved-then-off` (R1#4)                                            |
| Pending wrap, preceding character, combining marks                               | Kept                                            | `pending-wrap-*`, `rep-after-cut` (R1#6), `combining-at-cut`              |
| Joining and right margin                                                         | Kept                                            | `joining-after-sgr`, `wide-at-margin-nowrap` (R1#7)                       |
| Tabs, charsets, IRM, DECAWM, LNM, DECCKM, cursor                                 | Kept                                            | `custom-tabs`, `modes-basic`                                              |
| Paste, mouse, focus, keypad, cursor style, `?2026`                               | Kept (side tracker)                             | `modes-side-tracked`, `sync-open-at-cut`                                  |
| Unfinished string up to 64 KiB, and beyond                                       | Held tail; beyond it, fallback                  | `split-*` at every byte; Rust `tail_overflow_recovers`                    |
| Soft wraps, scrollback, reflow                                                   | Kept                                            | `softwrap-scrollback`, `softwrap-resize-reflow`                           |
| DECSCA protection on cells and pens; reverse wraparound `?45`                    | Kept, or fallback for the state's lifetime (D3) | `decsca-selective-erase`, `reverse-wrap-45`                               |
| Startup-query handoff                                                            | Kept                                            | `with_startup_queries` (R2#4)                                             |
| A setter xterm implements that no fixture covers                                 | Fallback (`UnsupportedState`)                   | Rust `unsupported_setter_falls_back`                                      |
| Images, kitty keyboard flags                                                     | Out of scope                                    | none                                                                      |

## 4. Test strategy

**Fixtures (F13).** A Rust test module in `screen.rs` runs streams through the real `TerminalScreen`: the reviewer's sequences above, named cases, and a seeded generator. At chosen cuts (every byte for split cases, 64 seeded offsets otherwise) it writes each checkpoint with its stream into `apps/web/src/components/__fixtures__/terminal-checkpoints/*.json`. `BIBCODE_UPDATE_SCREEN_FIXTURES=1` rewrites them; otherwise a stale fixture fails.

**Differential harness.** `apps/web/src/components/terminalCheckpoint.xterm.test.ts` uses `@xterm/headless` 6.0.0 with `@xterm/addon-unicode11` 0.9.0. Terminal A takes the whole stream. Terminal B takes RIS, then the checkpoint, then the rest. The harness compares:

- every cell of both buffers (characters, width, attributes, link);
- cursors, `modes`, the active buffer, the `isWrapped` flags, title and palette.

Headless xterm installs no browser colour handler (`CoreBrowserTerminal.ts`), so palette and colour-query state is compared through a harness-installed handler that mirrors the browser's, never by treating ignored colour operations as success.

Each stream ends with a probe tail (DECRC on each buffer, TAB, IND at the margin, leaving the alternate screen, `REP`, and a print at the pending wrap), so a state that looks right but is wrong shows up.

**Fixture hygiene (AGENTS.md Sensitive Data).** Real CLI streams (the Claude CLI, ConPTY output) are captured only in a throwaway home directory, with a placeholder project `example-group/sample-project`, the user `Test User` and synthetic prompts. A sanitizer script then replaces every occurrence of the capture's home, temporary root, host name and user name with placeholders. It fails on any remaining match of the repository's sensitive-data guard (`vp test run scripts`) or gitleaks. Titles and OSC 8 targets are rewritten to placeholders. A captured fixture is committed only after the sanitizer passes and a reviewer has read it.

| Layer                                                                                                                                       | Where                                               | Command                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Rust: screen, widths, fixtures                                                                                                              | `apps/server/src/terminal/screen.rs`                | `cargo test -p bibcode-server --lib -- terminal::screen`                                                                                |
| Rust: feed and resize order, fallback rule, clear, restart, exit, `adopt_current_state` on both routes and grant, snapshot permits, SIGCONT | `manager.rs`, `server_terminal.rs` tests            | `cargo test -p bibcode-server --lib -- terminal::manager production::server_terminal`                                                   |
| Contracts                                                                                                                                   | `packages/contracts`                                | from `packages/contracts`: `node ../../scripts/run-local-vp.mjs test run`                                                               |
| Client runtime: the D8 failing-first scripted test with its named cases                                                                     | `terminalTranscriptRuntime.test.ts`                 | from `packages/client-runtime`: `node ../../scripts/run-local-vp.mjs test run src/state/terminalTranscriptRuntime.test.ts`              |
| Web: harness, guarded query range, focus report                                                                                             | `apps/web/src/components/*.test.ts(x)`              | from `apps/web`: `vp test run --project unit src/components/terminalCheckpoint.xterm.test.ts src/components/terminalReplyGuard.test.ts` |
| Packaged end to end: cell-diff program, re-attach after eviction, resize while away, Profiler on                                            | `apps/desktop/e2e/specs/terminal-checkpoint.e2e.ts` | `vp run test:ui:desktop:build`, then `vp run test:ui:desktop`                                                                           |

## 5. Phases

| Phase                  | Goal                                                                                                            | Proof                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 0. Harness             | The engine behind `screen.rs`, fixture generator, differential test with the reviewers' sequences failing first | Harness green; the harness report settles D1 and D9   |
| 1. Shadow integration  | Feed and resize under the locks, fallback, profiler; nothing on the wire                                        | Rust manager tests; the D9 measurement recorded       |
| 2. Wire and server     | Capability, fields, `adopt_current_state`, snapshot permits, `readCheckpoint`, grant, SIGCONT                   | Rust and contract tests; an old client still gets raw |
| 3. Client              | Request field, guarded query range, per-renderer checkpoint fetch (D8)                                          | Runtime and web tests; React and `UI.md` reviews      |
| 4. End to end and docs | Packaged spec on macOS, the Linux lab and the Windows VM; overview, runbooks, changelog                         | Spec green with the Profiler on                       |

The user-visible fix arrives with Phase 3, after the other issues' plan has shipped Unicode 11 widths. If the harness is still red after two fix rounds, the question goes to the user (README).

## 6. Risks, open questions and agent's calls

Risks:

1. The engine's size and maintenance cost, known only from the harness report (D1).
2. Lock hold time and upstream lag under bursts (D9, measured before Phase 2).
3. Width and joining mismatch on input outside the corpus.
4. ConPTY output and the real Claude CLI stream: captured, sanitized fixtures (section 4).

Open questions:

1. The engine and its memory budget (D1, D9), pending the harness report.
2. None on upstream loss: the second review confirmed that dropping its invalidation is sound (R2, Q1).

Agent's calls:

- AC1: the engine is chosen by the harness report (D1).
- AC2: the request value `"checkpoint-unicode11"` names the width mode (D2, D6).
- AC3: three fallback reasons, each tracked and cleared per state (D3).
- AC4: synchronous feed under the locks, subject to the D9 measurement (D4).
- AC5: the harness decides the restoration order (D5).
- AC6: one `adopt_current_state` for lifecycle and lag, its lock order, and the restart grant to the carried-over owner (D6).
- AC7: every snapshot-carrying item is a heavy item; 4 MiB bound (D6).
- AC8: keep the first 16 queries within 1 KiB; the range is given in UTF-16 code units (D7).
- AC9: no client checkpoint cache; a per-renderer fetch with a 1 MiB or 4,096-event pending buffer and three refetches before falling back (D8).
- AC10: snapshot permits, one per attachment and eight per server, held until the client acknowledges the chunk, or, for a unary answer, until its frame is written (D6).
- AC12: the three-state `StartupGrant` and `take_startup_grant` as the only writer (D6).
- AC11: `terminal.clear` keeps exactly the side state RIS keeps, decided by `clear-matches-ris` (D3).
