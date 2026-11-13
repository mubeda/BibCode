# #350 Terminal re-attach: keep a server-side screen state instead of replaying a raw byte tail

## Problem

A window that re-attaches to a terminal is rebuilt from the server's raw byte history (1 MiB or 5,000 lines, `apps/server/src/terminal/history.rs`). Once a program's last full paint has left that history, the rebuilt screen lacks cells, the buffer type (the alternate screen) and the input modes (bracketed paste, application cursor keys, mouse tracking). A program that repaints by cell diff then shows missing characters. Reproduced on a real pair, 5 of 5, and present in v0.15.3.

#349 adds a best-effort recovery for Claude terminals that BiBCode starts on Unix servers (a `SIGCONT` after a lossy attach, so the CLI re-enters its screen and repaints). Everything else is still affected: Codex and other programs, plain shells running a full-screen program, Windows servers, and the modes of any program that does not re-assert them on resume.

## Proposed direction

The server keeps an emulated terminal screen per session and a snapshot becomes a checkpoint: bytes that rebuild the screen, both buffers, the modes and a bounded scrollback, followed by live output from an exact sequence.

## Results of a crate spike (standalone project, compared cell by cell against xterm.js 6.0.0)

Verdict
- No crate produces the checkpoint as is.
- avt 0.20.0 (Apache-2.0, 1 dependency, 0 unsafe) is the only workable base: with a wrapper of about 260 lines it passed every continuation case, every split-sequence position and streams 1, 2, 3, 5, 6 with 0 differing cells. Stream 4 (feature mix) differs in 36 cells: underline styles, `58;5;n`, OSC 8.
- vt100 0.18.1: not usable (no reflow, no DEC line drawing, no custom tab stops, no insert mode, no ?7, saved cursor not exposed).
- alacritty_terminal 0.26.0: not built; keeps the inactive grid, tab stops, scroll region and charset private; 38 dependencies.
- Main blocker: widths. Both crates use unicode-width 0.2.3; the installed xterm.js 6.0.0 uses Unicode 6 widths (emoji such as U+1F600 take 1 column in the client, 2 on the server). avt also gives zero-width characters a column. Options: load xterm's unicode11 or graphemes addon in the client (programs like the Claude CLI assume modern widths anyway), or fork the width function.

Wrapper parts (about 260 lines): side tracker for input modes, title, scroll region mirror (~100); hold-back feed of the unfinished escape tail, capped 64 KiB (~20); dump rewrite (DECRSPS to CUP, CTC to HTS/TBC, colon truecolour) (~55); SGR intensity fix (~40); scrollback serializer and pen SGR (~50).

Restoration order that passed: title; scrollback; primary paint; tab stops; primary saved cursor (with margins and origin if saved in origin mode, pending wrap by reprint); if alt active: CUP to primary cursor, SGR 0, `?1047h` (not `?1049h`), alt paint, alt saved cursor; DECSTBM; `?6h` only right before the final CUP; pen SGR, `?25l`, charsets, IRM, `?7l`, LNM, DECCKM; side-tracked modes (`?2004h`, mouse, `?1006h`, `?1004h`, keypad, cursor style); the raw held-back bytes. Note: re-enabling `?1004h` makes xterm.js send `CSI O` at once; the client's replay guard must drop it.

Numbers (release, one thread): avt alone 199 MiB/s (TUI) and 173 MiB/s (shell); with wrapper and hold-back 71 and 67 MiB/s (upper bound of the hold-back cost). Checkpoint time 0.14 ms for a TUI, 1.5 ms at 1,000 scrollback lines, 8.8 ms at 5,000. Memory at 120x40 with 5,000 scrollback lines: 13.3 MiB; empty scrollback 0.2 to 0.3 MiB. Checkpoint size: TUI about 4 KB; 1,000 lines about 161 KB (naive serializer).

Accepted losses unless more work: OSC 8 links, underline style and colour, `?2026` state, DCS/OSC prefixes over 64 KiB. Not tested: the real Claude CLI stream, ConPTY output, images, kitty keyboard flags, width growth, resize on the alt screen, invalid UTF-8.


## Requirements from the design review

The first design was reviewed and deferred. Its findings are the requirements for this work:

1. **P1 — A screen image is insufficient to resume the stream.** `apps/server/src/terminal/manager.rs:1881`. The spike must prove continuation equivalence, including both buffers, their saved cursors/attributes, scroll regions, origin and wrap modes, pending wrap, tab stops, character-set designation/selection, SGR, cursor style/visibility, title, input modes, and synchronized-output state. Otherwise a later restore-cursor, tab, scroll, or alternate-screen exit corrupts an apparently correct checkpoint.

   `vt100`’s formatter emits the active grid and selected modes; it is not a complete serialization of its parser and hidden state. Alacritty also keeps relevant state private, including tab stops, scroll region and inactive grid. **Smallest change:** make complete state access and continuation tests the crate-selection gate; withdraw the “small wrapper” and “300–500 lines” assumptions. [vt100 source](https://docs.rs/vt100/latest/src/vt100/screen.rs.html), [Alacritty source](https://docs.rs/alacritty_terminal/latest/src/alacritty_terminal/term/mod.rs.html).

2. **P1 — Sequence alignment does not preserve an unfinished escape sequence.** `apps/server/src/terminal/manager.rs:3380`. An output event can end with `ESC[5;`; the next event can contain `3HX`. A checkpoint containing only the screen loses that parser prefix. I reproduced this with installed xterm: uninterrupted output placed `X` at row 5, column 3; checkpoint-style reset followed by the continuation printed `3HX` on row 1.

   **Smallest change:** include pending parser input/state in the checkpoint contract, or checkpoint at a complete parser boundary and retain the exact intervening bytes and sequence coverage. Cover fragmented CSI, OSC, DCS, ST, character-set escapes, and synchronized-output transactions. Waiting indefinitely for a complete control string needs a bound and explicit failure policy.

3. **P1 — The proposed restoration order moves the restored cursor.** `apps/web/src/components/terminalReplyGuard.ts:51`. “Scroll region → cursor and SGR → modes” fails when modes include origin mode: xterm’s `DECSET ?6` homes the cursor. I reproduced the proposed ordering placing the next character at the region’s top-left instead of the saved position.

   Likewise, entering `?1049h` saves the normal cursor, so constructing the alternate buffer can overwrite state needed when it exits. **Smallest change:** specify an executable restoration algorithm: neutral painting state, buffer construction, saved-state construction, positioning-affecting modes, then final cursor/attributes/pending-wrap restoration. Test subsequent output and buffer exit, not just checkpoint appearance.

4. **P1 — Query-free checkpoints remove the existing startup-query handoff.** `apps/server/src/terminal/manager.rs:3571`; `apps/web/src/components/terminalReplyGuard.ts:100`. A program can emit DA/DSR before its first viewer attaches and wait for the answer. Today `firstAttachmentGrant` deliberately permits those historical queries once. An emulator that discards queries followed by a query-free checkpoint loses that request.

   The guard also does **not** prevent an owning xterm from generating replies during ordinary replay: it blocks their forwarding through `acceptInput()`. My probe confirmed DA/DSR were emitted but dropped during ordinary replay, and forwarded with the startup grant.

   **Smallest change:** define a generation-scoped, once-only startup-query handoff separately from checkpoint restoration. Checkpoints must never receive that grant. Keep the server emulator disconnected from PTY writes and discard emulator reply events—including Alacritty’s `PtyWrite` and query callbacks. Test DA, DSR, DECRQM, DECRQSS, colour queries, and focus reports triggered by restoring `?1004h`. [Alacritty events](https://docs.rs/alacritty_terminal/latest/alacritty_terminal/event/enum.Event.html).

5. **P1 — Checkpoint plus capped deltas still lacks a valid replay protocol.** `packages/client-runtime/src/state/terminalTranscriptRuntime.ts:292`, `:324`, `:381`. There is no client-requested resync API today; the existing resync is server-initiated after stream lag. More fundamentally, the runtime stores output bytes but only the **latest** size. A second renderer joining after checkpoint → output → resize → output receives all bytes at the final dimensions, even without eviction.

   **Smallest change:** retain checkpoint dimensions and an ordered journal of output and size changes, or invalidate cached replay after a geometry change and obtain a fresh checkpoint before hydrating another renderer. Define the actual refresh mechanism, single-flight behavior, generation fencing, cancellation, and event buffering during refresh. Never replay a checkpoint followed by deltas with an evicted middle.

6. **P1 — The old-client compatibility claim is false.** `packages/client-runtime/src/state/terminalTranscript.ts:43`; `apps/server/src/terminal/manager.rs:4966`. The cap cuts at a UTF-8 boundary, not a checkpoint or escape boundary. The indispensable state alone can exceed 512 KiB: the server accepts 1,000×500 terminals and two screens.

   I tested a 1,007,792-byte two-screen checkpoint. After the legacy cut, the alternate screen appeared intact, but exiting it restored a damaged normal screen: its first row contained 228 characters instead of 1,000. No scrollback was involved.

   **Smallest change:** negotiate checkpoint support in the attach request and keep an explicitly limited legacy path, or prove the entire required checkpoint fits every legacy constraint. An optional response field cannot make old clients retain it. Add the field to Rust’s `apps/server/src/terminal/model.rs:228` as well as the TypeScript schema. Mixed windows need per-attachment format selection over the same canonical state.

7. **P1 — The resize hook list misses the PTY’s eventual retained size.** `apps/server/src/terminal/manager.rs:3964`. `publish_kept_size()` changes dimensions after resize retries are exhausted. Updating the emulator only at `:3923` leaves it at the refused dimensions while clients apply the retained dimensions; later output and checkpoints diverge.

   **Smallest change:** update emulator geometry at every authoritative dimension transition, including `publish_kept_size()`, under the existing ordering locks. Ownership-only and equal-size acknowledgement events must not resize the emulator. Test requested size → output → retained-size correction → output → attach.

8. **P1 — The emulator’s input already has a lossy boundary.** `apps/server/src/terminal/manager.rs:2911`, `:3411`. The publisher can receive `Lagged` from the PTY output broadcast. Its gap handler repairs private-output redaction state; it cannot recover missing terminal commands. An omitted alternate-screen switch or scroll-region command leaves the emulator permanently wrong, while the design labels its checkpoint lossless. Extra parsing can increase this exposure.

   **Smallest change:** give authoritative emulation a lossless ordered input path, or explicitly invalidate checkpoint authority on upstream loss and define recovery. A downstream attach resync cannot repair an already-corrupted server emulator. Distinguish upstream loss from a viewer merely falling behind.

9. **P1 — Unsupported state becomes permanently absent from new attaches.** `apps/server/src/terminal/manager.rs:1881`; `apps/web/src/components/ThreadTerminalPanel.tsx:1437`. Keeping raw history exclusively for `read_history` does not preserve unsupported data for viewers. OSC 8 is supported by this client; dropping link attributes makes reattached text lose its link. Similar losses apply to palette changes and other supported setters. Blindly appending unknown raw sequences afterward is unsafe because their original ordering and cursor context matter.

   The installed xterm uses Unicode provider **6**; my probe gives U+1FAE0 width 1. Server width and grapheme handling must match the actual client configuration, including combining marks, variation selectors, ZWJ sequences and right-margin wide characters.

   **Smallest change:** define a supported-state matrix and explicit unsupported-state policy before choosing the crate. Preserve OSC 8 and supported colour state. Images are currently outside this panel’s installed addons; do not claim image preservation. Require width/reflow differential tests against xterm. `vt100` explicitly truncates/extends rows on width changes rather than reflowing them. [vt100 resize contract](https://docs.rs/vt100/latest/vt100/struct.Parser.html).

10. **P2 — The scrollback proposal silently reduces retention and destroys soft-wrap information.** `apps/web/src/components/ThreadTerminalPanel.tsx:1429`; `apps/server/src/terminal/history.rs:290`. Today a small-line shell transcript can retain roughly 5,000 lines within both byte caps. A 1,000–2,000-line emulator limit loses previously available output. Serializing every physical row with CRLF turns soft wraps into hard line breaks, changing later reflow, selection and text-search semantics.

    **Smallest change:** retain the current intended history depth subject to an explicit memory budget, and preserve logical-line/soft-wrap boundaries and attributes. Checkpoint scrollback can improve colour consistency and remove obsolete repaint bytes, but cannot preserve text that was overwritten on-screen as an operational transcript. There is no terminal SearchAddon in this panel today; do not describe search parity as already implemented.

11. **P2 — The cost estimate is not a bound, and snapshot work needs its own budget.** `apps/server/src/terminal/manager.rs:3370`, `:1873`; `apps/server/src/production/server_terminal.rs:964`. Synchronous parsing extends the publication/session critical section, delaying typing, resize, attach and close. Serialization scans retained cells under that lock too. The xterm throughput measurement establishes no Rust upper bound.

    At permitted maximum dimensions, two grids plus 2,000 scrollback rows represent up to three million cells—about 36–72 MB using the design’s own cell estimate, before auxiliary allocations, raw history and snapshot copies. Exited sessions retain history, so this is not only a running-terminal cost.

    **Smallest change:** gate the spike on measured lock hold time, input latency, burst throughput, upstream lag, attach latency and retained RSS across many terminals. Bound checkpoint bytes and auxiliary state; account for initial/restart snapshots as well as resyncs. Profiler coverage should include parse/serialize duration, queue lag and checkpoint size without recording terminal content.

12. **P2 — A smaller retention heuristic cannot establish a valid checkpoint.** `apps/server/src/terminal/history.rs:258`. `ED 2` clears cells without resetting cursor, modes, saved state or the hidden screen. Alternate-screen entry also depends on earlier normal-screen state. Retaining from either marker therefore remains insufficient, and a hard cap eventually recreates the reported long-running failure.

    **Smallest acceptable alternative:** a rolling emulator state plus a bounded ordered journal, advanced on attach and before journal eviction. This can batch parsing and move work out of the session critical section, provided snapshots fence an exact generation/sequence and trimming never outruns committed parser progress. It still requires the same fidelity; sustained output eventually requires parsing every byte. Retain the parser itself rather than reconstructing it repeatedly from an incomplete display serialization.

13. **P2 — The spike tests can pass while the implementation remains broken.** `packages/client-runtime/src/state/terminalTranscriptRuntime.test.ts:68`; `apps/web/src/components/terminalReplyGuard.test.ts:35`. A hand-authored checkpoint fixture and 40 ordinary diff frames do not exercise the Rust serializer, pending parser state, hidden buffers or cached resize ordering.

    **Smallest change:** generate fixtures with the actual pinned Rust implementation and compare uninterrupted xterm against checkpoint-plus-continuation at varied chunk boundaries. Include the failures above, saved-cursor restoration, tabs/charsets, normal-screen return, OSC 8, wrap/reflow, synchronized-output completion, startup/live reply counts, clear/restart/exit, stale generations, upstream/downstream lag, refresh during output and legacy truncation. Exercise the actual attach/runtime/panel path. The licences match the proposal—MIT and Apache-2.0—but maintenance and serializer effort remain unproved; a one-day deadline is not an acceptance criterion. [vt100 manifest](https://docs.rs/crate/vt100/latest/source/Cargo.toml), [Alacritty manifest](https://docs.rs/crate/alacritty_terminal/latest/source/Cargo.toml).

14. **P2 — The resize investigation must distinguish notifications from PTY changes.** `apps/server/src/terminal/manager.rs:3586`, `:3911`; `apps/web/src/components/ThreadTerminalPanel.tsx:1910`. Same-size `resized` events are intentional ownership changes or acknowledgements. Existing-session attach dimensions do not themselves resize the PTY.

    The actual 85×33 request can arise afterward: applying the snapshot triggers a layout/attach claim, which measures the mount and sends a resize at `:1847`. Automatic settling considers mount pixels, with a 100 ms quiet period and 500 ms maximum wait; font metrics and delayed Activity-dock layout can change fitted rows afterward. The dock explicitly consumes terminal rows at `:2934`.

    **Smallest change:** instrument trigger, mount dimensions, fitted dimensions, font metrics, claim and actual PTY resize calls. These are source-backed candidates, not a reproduced attribution of the three rows. Keep the fix separate, but prove checkpoint replay causes no unintended PTY dimension changes.

15. **Sound — The synchronous checkpoint’s sequence boundary and basic lifecycle placement.** `apps/server/src/terminal/manager.rs:1958`, `:3380`, `:3636`, `:4891`. Feeding exactly the redacted published bytes before advancing sequence, then reading emulator state and sequence under the same session lock, preserves the existing snapshot/live handoff. Subsequent **events** advance the sequence; the next output need not be exactly `sequence+1` because other event types consume numbers.

    Fresh state on generation creation, reset alongside the existing clear/RIS semantics, and retaining final state after exit fit current behavior. Preserve final output draining and redaction-tail flushing. The exited suffix remains usable only when serialized buffer transitions accurately describe the checkpoint.

16. **Sound — Keeping operational history separate, and absent-format fallback.** `apps/server/src/terminal/manager.rs:4434`; `apps/server/src/mcp/tools/terminals.rs:522`; `packages/contracts/src/terminal.ts:270`. Keeping raw history preserves MCP raw/stripped reads, byte cursors, epochs and dropped-window reporting. An absent `historyFormat` can preserve this client’s current behavior with older servers, including its known replay limitation.

Read-only verification used source inspection and two in-memory Node probes (`node -e …` and `node --experimental-strip-types --input-type=module -e …`). No files changed; the pre-existing untracked file remains. No Rust spike, full suites, native E2E or real-machine reproduction ran. CodeGraph sync was skipped because this review prohibited writes.




## Comment 2026-11-13T04:00:51Z

Another case this issue covers, found while validating mubeda/BibCode#349 with the macOS app as client: a re-attach replays the raw byte history into a fresh terminal at the PTY's current size. When the PTY was resized while that window was away and the history is complete (so no repaint is requested), bytes written for the old size land differently at the new size. With a stand-in program that repaints on resize without erasing the whole screen, the returning window showed 4 stale rows that an attached window did not (5 of 5 runs). A headless xterm.js probe reproduces the class without a browser (all 39 rows differ for a program using relative cursor moves; 0 rows when the program erases the screen on resize or uses only absolute moves). Whether the real Claude CLI is affected is not known. A narrower stopgap would be to also request the repaint for a Claude provider terminal when the PTY size changed since the history began; its cost is a signal on most attaches in two-window use.
