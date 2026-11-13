# #350: server-side terminal screen (status on 2026-11-13)

State: **design in rework, no code written.** This folder is not yet a plan folder (it has no `plan.md`).

- `terminal-screen-design.md`: first design draft. Status Draft.
- `reviews/design-review-1.md`: Codex (`gpt-6.1-sol`, effort high) review of that draft. Verdict: needs rework, 13 findings, several reproduced against the installed xterm 6.

## What the review settled

Accepted findings, in two groups:

1. **Serializer fidelity (findings 4 to 7).** The restoration order written in prose still breaks on byte sequences the reviewer produced: a saved cursor taken in origin mode, the inactive alternate screen's saved state, saved character sets, the preceding-character state that `REP` and combining marks use, and xterm's behavior at the right margin with auto-wrap off. Two rounds on paper each produced new failing sequences. The restoration order is therefore to be settled by the differential harness, not by prose: the reviewer's sequences become fixtures that fail first, plus a seeded generator, and the harness compares an uninterrupted `@xterm/headless` terminal with checkpoint-plus-continuation.
2. **Protocol (findings 1 to 3, 9, 10).** A harness cannot catch these, so they need a revised design and a second review: the client's refetch must not drop events the live renderer still needs; the startup-query handoff must not reset the terminal again; catch-up after a restart must be fenced by generation; snapshot bytes must be budgeted on every delivery path; memory must be budgeted for combined text and links, not only cells.

Findings 11, 12 and 13 were about the other issues' spec and are fixed there (`../2026-11-13-issue-batch-348-358/spec.md`: R1, R35, R12).

## Facts established after the review

- **Upstream loss needs no invalidation.** When the publisher falls behind the PTY reader, attached windows receive only the published gap event (`publish_output_gap` in `apps/server/src/terminal/manager.rs`); the lost bytes reach nobody. A server screen fed with exactly the published bytes therefore still equals a window that stayed attached, which is the goal. Marking the screen invalid would only make a re-attach worse than an attached window. The first draft's `UpstreamLag` invalidation and the "valid again after RIS" rule are to be dropped; RIS does not reset the title in xterm, as the review showed. To confirm with the reviewer in round 2.
- **avt 0.20.0's API** (from its source, per the review): the type is `avt::Terminal`, not `avt::Vt`; `Line::is_wrapped()` is public and means "continues onto the next row"; the saved cursor and character sets are private, the saved cursor holds no character set, and there are two character-set slots; the scrollback limit is set at construction only; `dump()` omits scrollback and targets a fresh avt terminal. Vendoring is feasible, but the patch is larger than the three changes the draft names.
- The browser xterm's `unicode` getter requires `allowProposedApi`, and restoring focus reporting reaches the focus report synchronously.
- The client's switch to Unicode 11 widths ships with the other issues (R5 there), so it is no longer part of this work.

## Next steps, in order

1. Harness first: vendor avt under `third_party/avt`, write `apps/server/src/terminal/screen.rs` and the fixture generator, and add the differential test with the reviewer's failing sequences. No manager, wire or client change.
2. Revise the design's protocol sections (client refetch, startup queries, generation-fenced catch-up, budgets) and get a second Codex review plus the advisor's.
3. Only then write `spec.md` and `plan.md` here and implement the wire and client phases.

The user decided on 2026-11-13 that the pull request waits for this work and closes #350 with the other nine issues. If the harness is still red after two fix rounds, the question goes to the user: keep going, or choose a different base for the emulator.
