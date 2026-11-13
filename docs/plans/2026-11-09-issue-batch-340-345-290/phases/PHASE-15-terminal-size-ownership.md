# Phase 15: One terminal in several windows keeps its last lines

- Goal: A terminal shown in two windows of different size never loses its bottom lines: the window last used sizes it, other windows scale the picture to fit, and every window converges on the size the server holds (#348, amendment A14).
- Round: 5
- Depends on: 10
- Owns: `apps/web/src/components/ThreadTerminalPanel.tsx`, `terminalSizePolicy.ts`, `terminalReplyGuard.ts`, `packages/client-runtime/src/state/terminalTranscriptRuntime.ts` and `terminal.ts`, `apps/server/src/terminal/manager.rs` and `pty.rs`, `apps/server/src/production/server_terminal.rs`, the terminal contracts, `apps/desktop/e2e/specs/terminal-footer-invariant.e2e.ts`, and their tests
- Shared files: `CHANGELOG.md`, `docs/architecture/rpc-and-orchestration.md`, `docs/architecture/overview.md`, `docs/user/workspace-ui.md`
- Must not touch: provider runtimes, the transcript persistence format
- Skills: mstack-diagnose (a signal before any theory); test-driven-development; vercel-react-best-practices; bibcode-profiler (every app run has the Profiler on)
- Read first: `spec.md` R113 to R118 and D52 to D54; GitHub issue #348; `docs/architecture/rpc-and-orchestration.md` (terminal RPC rows)
- Checkpoint: `cargo test -p bibcode-server -j 2 terminal` exits 0, and from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/components/ThreadTerminalPanel.test.tsx` exits 0.

## Tasks

### Task 15.1: A footer invariant spec and the reproduction record

- Satisfies: support (the signal for R113 to R118)
- Depends on: none
- Files: create `apps/desktop/e2e/specs/terminal-footer-invariant.e2e.ts`
- Interfaces: produces a packaged spec that drives seeded layout steps against a footer-drawing fixture program and fails when the last rows are cut off or missing.
- Skills: mstack-diagnose
- Read first: `docs/testing/README.md`
- Tier: most capable
- TDD: exempt (the spec is the test; it is proven able to fail by clipping the mount by hand)
- Done when: in the Linux lab, `BIBCODE_E2E_SPEC=terminal-footer-invariant vp run test:ui:desktop` exits 0

Steps

1. [ ] Write the spec and its fixture program; prove it fails when the terminal mount is clipped. Run the command under Done when. Expected: PASS on an unclipped terminal.
2. [ ] Record, per environment, the steps run and whether the symptom appeared.

### Task 15.2: A mirror scales the picture and never clips

- Satisfies: R113 (focus, key and pointer take the size; an idle window does not), R114 (a taller owner; the floor; a larger window)
- Depends on: 15.1
- Files: modify `apps/web/src/components/ThreadTerminalPanel.tsx`, `apps/web/src/components/terminalSizePolicy.ts` and their tests
- Interfaces: produces `terminalMirrorScale`, `applyMirrorScale` and `TERMINAL_MIRROR_MIN_SCALE` (0.5).
- Skills: test-driven-development; vercel-react-best-practices
- Read first: `UI.md`
- Tier: most capable
- TDD: red-green
- Done when: from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/components/terminalSizePolicy.test.ts src/components/ThreadTerminalPanel.test.tsx` exits 0

Steps

1. [ ] Write a two-window test in which the owner is taller than the mirror and assert the mirror shows the whole grid. Run the command under Done when. Expected: FAIL, the mirror is clipped.
2. [ ] Scale the mirror to fit, floor the scale and pin the scroll to the bottom below it, and say the scale in the notice. Run the command under Done when. Expected: PASS.

### Task 15.3: The resize answer states what the server holds

- Satisfies: R115 (applied, unchanged and the refusal outcomes; an equal claim acknowledged in order; a stale answer ignored)
- Depends on: 15.2
- Files: modify `apps/server/src/terminal/manager.rs`, `apps/server/src/production/server_terminal.rs`, `packages/contracts/src/terminal.ts`, `packages/client-runtime/src/state/terminalTranscriptRuntime.ts` and their tests
- Interfaces: produces the `terminal.resize` answer `{ outcome, size, generation, sequence }`, `TerminalGeneration { boot, process }` and the requester-only `resized` acknowledgement.
- Skills: test-driven-development
- Read first: `docs/architecture/rpc-and-orchestration.md`
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-server -j 2 terminal` and `vp run check:contracts` exit 0

Steps

1. [ ] Write manager and wire tests for each outcome and for ordering by generation and sequence. Run `cargo test -p bibcode-server -j 2 terminal`. Expected: FAIL.
2. [ ] Implement the answer, the acknowledgement and the client ordering; regenerate the fixtures. Run both commands under Done when. Expected: PASS.

### Task 15.4: Mixed versions keep working in both directions

- Satisfies: R116 (older client with a new server; new client with an older server; input frames)
- Depends on: 15.3
- Files: modify the same server and contract files, `apps/web/src/components/ThreadTerminalPanel.tsx`, `apps/server/src/lifecycle.rs` and their tests
- Interfaces: produces the optional request field `structuredResult` and the server capability `terminalUserInputClaim`.
- Skills: test-driven-development
- Read first: the released contract at tag v0.15.3
- Tier: most capable
- TDD: red-green
- Done when: `vp run check:contracts` exits 0 and the contracts suite passes

Steps

1. [ ] Decode the new answer with the released client's codec in a contract test. Run the contracts suite. Expected: FAIL, `Expected null`.
2. [ ] Answer the structured object only when asked, skip the acknowledgement otherwise, and send the input origin only to a server that advertises the capability. Run the command under Done when. Expected: PASS.

### Task 15.5: Typing is told apart from the terminal's own replies

- Satisfies: R117 (an automatic reply; several viewers after the owner leaves; an older client's unmarked input)
- Depends on: 15.4
- Files: modify `apps/server/src/terminal/manager.rs`, `apps/web/src/components/terminalReplyGuard.ts`, `apps/web/src/components/ThreadTerminalPanel.tsx` and their tests
- Interfaces: produces the optional `userInputClaim: string | null` on `terminal.write` and `terminal.writeInput`.
- Skills: test-driven-development
- Read first: the reply guard and the input scheduler
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-server -j 2 terminal` exits 0 and the reply guard tests pass

Steps

1. [ ] Write `an_automatic_reply_does_not_keep_the_size_from_the_returning_owner` and `the_size_goes_to_the_remaining_viewer_typed_in_last`. Run the command under Done when. Expected: FAIL.
2. [ ] Mark input with its origin, keep origins in separate frames, and hand the size to the viewer typed in last. Run the command under Done when. Expected: PASS.

### Task 15.6: A refused low-level resize is retried, then the truth is published

- Satisfies: R118 (refused then accepted; refused on every retry; replaced by a newer request)
- Depends on: 15.3
- Files: modify `apps/server/src/terminal/pty.rs`, `apps/server/src/terminal/manager.rs` and their tests
- Interfaces: produces the worker's `ExhaustedResize { requests, cols, rows }` report.
- Skills: test-driven-development
- Read first: the resize worker
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-server -j 2 refused` exits 0

Steps

1. [ ] Write real-PTY tests with an injected failing resize. Run the command under Done when. Expected: FAIL, a timeout.
2. [ ] Retry after 100 ms, 500 ms and 2 s, then publish the size the PTY kept and log a warning without terminal content. Run the command under Done when. Expected: PASS.

### Task 15.7: The real pair, on the final build

- Satisfies: R113, R114 (the owner's setup: a macOS client of a Linux desktop server)
- Depends on: 15.5, 15.6
- Files: none in the repository; the run report
- Interfaces: consumes the final Linux AppImage as server and a second client.
- Skills: bibcode-profiler; mstack-diagnose
- Read first: `progress.md` (the log entry of the real-pair run on the older builds)
- Tier: standard
- TDD: exempt (a validation run, no new behavior)
- Done when: observable in the run report: for each of the five recorded cases, a client clipped by 0 px, no unattended take-back and a click that claims, with every Profiler finding classified

Steps

1. [ ] Run the recorded cases on the final build with the Profiler on and measure pixels, not only state.
2. [ ] Classify every Profiler finding as caused by the change, pre-existing or a test artifact.

### Task 15.8: Documentation and changelog

- Satisfies: support (documentation of R113 to R118)
- Depends on: 15.5, 15.6
- Files: modify `docs/architecture/rpc-and-orchestration.md`, `docs/architecture/overview.md`, `docs/user/workspace-ui.md`, `CHANGELOG.md`
- Interfaces: consumes the behavior of Tasks 15.2 to 15.6; produces no names.
- Skills: none
- Read first: the terminal rows of `docs/architecture/rpc-and-orchestration.md`
- Tier: cheap
- TDD: exempt (documentation only, no behavior to test)
- Done when: `vp run check:markdown-links` exits 0 and `rg -c "#348" CHANGELOG.md` prints 1 or more

Steps

1. [ ] Describe size ownership, the scaled mirror, the resize answer and the mixed-version rules; add one changelog line.
2. [ ] Run `vp run check:markdown-links`. Expected: no errors.
