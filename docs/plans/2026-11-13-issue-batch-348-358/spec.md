# Issue batch: terminal fidelity, Git and worktree follow-ups, update guard and web fixes

Status: Approved 2026-11-13 (the user's standing pre-approval of 2026-10-30: reviewed by Codex twice and by the advisor, findings handled; the agent's calls D2, D4 to D13 are listed for the user's confirmation before the push)
Size: full Mode: gated Type: bug class and chore (#348, #351 to #358) and feature (#350)
Source: GitHub issues #348 and #350 to #358 of this repository as they stood on 2026-11-13 (copies in `sources/`), the conversation of 2026-11-13 ("process all open issues, fix them all in this PR"), and a read of `main` at `a9938193b` by five read-only verifiers. Evidence record: [evidence.md](evidence.md). #350 has its own folder, [../2026-11-13-terminal-screen-350/](../2026-11-13-terminal-screen-350/terminal-screen-design.md), because its design did not pass its first review.

The ten issues hold 45 separate items. Most were filed as "found by reading the code" or "not decided", so each item was checked against the code first. This spec gives every item one disposition:

- **Fix**: a requirement with a test that fails first.
- **Decide by test**: the test or probe is the deliverable. Its result picks the fix or records that there is no defect.
- **Record the limit**: the item is real, a fix is not justified, and the code or the docs say so.
- **Covered by**: another requirement in this spec delivers it.

An issue is closed by the pull request only when every one of its items has evidence under its disposition.

Names used throughout:

- **Raw history**: the byte history the server keeps today (1 MiB or 5,000 lines).
- **Owner** and **mirror**: the window that sizes a terminal, and any other window that shows it.
- **Creation record**: the row BiBCode stores when it creates a worktree (#344).
- **Lookup**: the shared open-pull-request lookup behind the status stream.
- **Installing dialog**: the "Installing an update" dialog shown while a remote update install runs.

## Problem

- **#348.** Terminal rendering sometimes stays wrong until a panel is resized. #349 fixed three causes. Two gaps remain in the code: a font that loads late is never re-measured, and a terminal created after its host configuration arrives is not repainted when the bundled font finishes loading. There is no content-free record to tell a geometry fault from a repaint fault.
- **#350.** A window that re-attaches to a terminal is rebuilt from raw history. Once a program's last full paint has left that history, cells, the alternate screen and input modes are lost. Bytes written for one size are also replayed at another. #349's `SIGCONT` recovery covers only Claude terminals on Unix servers.
- **#351.** On Windows, expanding a reasoning row scrolls the chat to its end (1014 px against a 2 px limit in the packaged spec).
- **#352.** One worktree removal test times out in about one of three whole-suite runs under load.
- **#353 to #358.** Thirty-five smaller items left over from #349: wrong or missing behavior at edges (locks, lookups, creation records, the update guard, popups under a native preview), four lab observations with no known cause, and missing documentation.

## Goals

1. A terminal shows its current output with the right glyph metrics after a late font load or a late creation, without a manual resize.
2. Terminals count character widths the way current programs do. (The larger goal of #350, a re-attached window that equals one that stayed attached, is in the #350 folder.)
3. Expanding a reasoning row that is not at the end of its turn leaves the chat where it was.
4. Every item of #352 to #358 is fixed, decided by a recorded test, or recorded as a limit in the code or docs.
5. No test in this batch depends on a wall-clock bound that load can exceed.

## Non-goals

- Replacing xterm.js or changing its version (6.0.0 stays): no evidence a newer line fixes these items.
- The server-side terminal screen of #350: planned in its own folder (D2).
- A new CI lane that runs a new client against an older server binary: R19 runs the check once with a script; a lane is a separate decision.
- Signing in to Git from the client, new update-install UI beyond the installing dialog's exit, and changes to worktree record schema beyond returning the row id.
- Speculative fixes for the four lab observations when the bounded probes of R20, R43, R44 and R45 produce no signal.

## Decisions

- D1. One pull request covers all ten issues. Decided by: user, 2026-11-13.
- D2. #350 is planned in its own folder on the same branch, and no #350 wire code is written before its design passes a second review. Its first design failed review on continuation fidelity and on the refresh protocol, so its serializer is settled by a differential test harness, not by prose. The pull request is held until #350 lands with proof: it closes all ten issues, so that the repository has no open issue. Decided by: user, 2026-11-13 ("Hold PR for #350, I want 0 issues in the repo").
- D3. A design or plan counts as approved once Codex and the advisor have reviewed it and their findings are handled (standing pre-approval of 2026-10-30). Decided by: user's standing rule.
- D4. The client switches to Unicode 11 widths now, in every terminal, whatever the server (R5). It is the prerequisite #350 names and fixes #353 item 8 on its own. Decided by: agent's call.
- D5. `pull` stays out of `takes_index_lock`. Its merge child holds the lock, the ownership check sees only the root process, and listing it would arm the Windows 2-second rule during the fetch. Decided by: agent's call, from the code.
- D6. A failed lookup is remembered for 5 seconds. A cancelled lookup is never remembered. An invalidation clears it. Decided by: agent's call.
- D7. A remembered pull request stops being shown when a lookup fails and the last successful lookup is more than 5 minutes old. Time alone never hides it: nothing looks up an idle branch, so a pure age limit would hide a valid request. Alternative: record the limit only (keeps a wrong request on screen for as long as the forge is unreachable). Decided by: agent's call, to confirm with the user at approval.
- D8. `spawn_for_subscribers` keeps dropping a late lookup when nobody subscribes: nothing would show the answer and the next refresh asks again. Decided by: agent's call.
- D9. A creation record is reaped only when its own folder is missing and that folder's parent directory exists. A missing parent means the audit cannot tell a removed worktree from an unmounted volume, so the record is kept. `git worktree list` cannot be the gate: it succeeds from a readable repository and only marks the missing worktree prunable. Cost: records under a managed directory that was deleted as a whole are never reaped. Decided by: agent's call.
- D10. No folder identity is added to creation records, and the `.git` pointer read is not moved to a directory handle. Both would be schema or boundary changes for an advisory, warning-only read. Decided by: agent's call.
- D11. Tooltips take no occlusion lease: a lease on hover would flicker the native preview. Decided by: agent's call.
- D12. A dedicated `terminalSizeHandOver` capability is added although no released server advertises one flag without the other; it is cheap and removes a silent coupling. Decided by: agent's call.
- D13. The Fit button keeps sending nothing when the server already declined that size; it says so instead. Decided by: agent's call, from the existing test.
- D14. Test names, fixtures and docs use placeholders only (repository rule on sensitive data).

## Requirements

Priority is Must unless marked. "Test seam" names the existing test file that takes the failing-first test.

**#348 Terminal rendering**

### R1. Late font load

WHEN any font finishes loading in the document while a terminal is rendered, the terminal SHALL re-measure and repaint at its current size.
- Given a rendered terminal with an unchanged mount size, When `document.fonts` dispatches `loadingdone`, Then the terminal is re-measured and `clearTextureAtlas` and `refresh` each run once. An owner refits. A mirror keeps the server's columns and rows and sends no size claim: the test uses a fit mock that really resizes the terminal, as the real fit addon does, and asserts the mirror's grid is unchanged. The assertions for owner, mirror and the legacy path equal those of the existing device-pixel-ratio test.
- Given a real xterm with an unchanged mount size, When the font's glyph metrics change and `loadingdone` fires, Then the terminal's cell dimensions are measured again before any size is proposed (a repaint alone is not enough: the fit addon reads cached cell dimensions).
- Given the terminal is unmounted, When `loadingdone` fires, Then nothing runs.
- Test seam: `apps/web/src/components/ThreadTerminalPanel.interactions.test.tsx`, next to "refits when the device pixel ratio changes under an unchanged mount".
### R2. Late creation

WHEN a terminal's renderer is created after its host configuration arrives, the terminal SHALL repaint once the bundled font has loaded, and a font callback for a disposed renderer SHALL do nothing.
- Given an AI terminal waiting for host configuration, When configuration arrives and the pending font load then resolves, Then `clearTextureAtlas` and `refresh` run on the new renderer and exactly one resize is issued for the initial geometry.
- Test seam: same file, "waits for authoritative host config before attaching Codex".
### R3. Same-size return

WHEN a mount returns from no area to the same positive size, the terminal SHALL repaint. Test only: add the `refresh` assertion to "never sizes the PTY from a mount with no area and refits when it returns".
### R4. Size diagnostics

WHERE development diagnostics are enabled, the terminal SHALL keep a bounded in-memory record of sizing and repaint decisions that holds no terminal content.
- Each record holds: trigger, renderer generation, mount width and height, fitted and applied columns and rows, owner or mirror, device pixel ratio, `document.fonts.status`, renderer kind, the size request and its outcome, repaint scheduled and done.
- The ring holds the last 200 records. With diagnostics off, nothing is recorded.
- Given output is written to the terminal, Then no record contains any written byte.

**#350 Server-side terminal screen (only the client's width mode is in this spec)**

### R5. Modern widths in the client

Every terminal in the client SHALL count columns by Unicode 11 (the `@xterm/addon-unicode11` provider), so an emoji takes two columns as programs such as the Claude CLI assume. Given a real xterm built with the panel's options, When U+1F600 is written, Then the cursor advances 2 columns; before the change it advances 1. Covers #353 item 8. Server-side width parity belongs to #350.
**R6 to R11: withdrawn from this spec.** The server screen, checkpoints, negotiated attach, client replay, the recovery path and the budgets are specified and planned in the #350 folder. Its first design review (Codex, 2026-11-13) returned "needs rework" with 13 findings, so no #350 wire code is planned here. The numbers R6 to R11 stay reserved so that later numbers do not move.

**#351 Reasoning rows**

### R12. Reasoning row keeps its place

WHEN the reader has brought a reasoning row into view away from the turn's end and expands or collapses it, the row's header SHALL stay within 2 px of where it was. This is the invariant the packaged spec `chat-reasoning-rows` asserts in `expandThoughtAwayFromEnd` (scroll the row to the center, toggle, compare the header's position).
- Diagnose first, before any fix. Known on 2026-11-13: the packaged harness already runs at a 1000x720 viewport on every platform, and the spec passes there on Linux (WebKitGTK), so neither that viewport nor the shared code alone reproduces it; Windows differs by WebView2 (Chromium) and a device pixel ratio of 2. Step 1: get a live trace of which code path scrolls (the toggle's end reveal, the grown-turn follow, or the list's end maintenance, with the real value of each decision), from Chromium at device pixel ratio 2 if that reproduces it, otherwise from the Windows VM. Step 2: a unit test reproduces that path with the trace's metrics. The fix goes at the first wrong decision the trace names; no fix is chosen before it.
- Given the reader scrolled a reasoning row to the center without a wheel or touch gesture (a programmatic scroll), When the row is toggled, Then no scroll to the end is made within three animation frames.
- Given one work row that groups `[thought A, tool B, thought C]`, When thought A is toggled, Then its header stays in place (A is not the newest thought although no later list row exists), and toggling C at the turn's end still reveals the end.
- Given the newest reasoning row at the end of an anchored turn, Then the existing reveal still happens (the #173 behavior, asserted by `expandStreamingThoughtAtEnd`).
- Proof on Windows: the packaged `chat-reasoning-rows` spec passes in the Windows VM at the viewport where it failed.
- Test seam: `apps/web/src/components/ChatView.test.tsx`, "a pointer press on a Thinking row's toggle before a toggle at an anchored turn's end".

**#352 Flaky removal test**

### R13. Deterministic removal test

The test `removal_refuses_when_an_admission_does_not_drain_before_the_deadline` SHALL wait on the drain having been entered and on the removal's result, with a 30-second guard that only a real hang reaches. The injected 20 ms drain timeout stays. Proof, chosen in advance: (1) red first: with the removal delayed by 2.5 seconds before its drain (a test-only delay), the old test fails with `bounded admission drain: Elapsed` and the new test passes; (2) 50 of 50 runs of the test alone under CPU load on the Mac; (3) 12 of 12 whole-suite runs in the Windows VM (a 1-in-3 flake passes 12 runs less than 1% of the time).

**#353 Follow-ups from #349**

### R14. Other AppImage mounts

A read-only FUSE mount whose mount point's last component starts with `.mount_` SHALL be hidden from Host dashboard volumes as a system mount, whether or not this process runs from it, and SHALL never be read.
- Given `/tmp/.mount_OtherY` with file system `fuse.BiBCode-1.0.AppImage` and the executable elsewhere, Then it is hidden. Given `/mnt/tools` with `fuse.gocryptfs`, Then it is shown.
### R15. Dead webview probe

The packaged e2e harness SHALL check for a dead webview before every test, not once per worker, and relaunch within the test's time allowance. The "per spec file" comment is corrected.
### R16. Re-attach size transient (decide by test)

Using R4's record, a test replays an attach followed by a font-metrics change and an Activity dock change. IF a size request with different rows is sent and then reverted, the settle rule is fixed so that only the final size is requested; otherwise the result is recorded and no code changes.
### R17. Fit feedback

WHEN "Fit to this window" is pressed and no size request can be sent, the size notice SHALL say that the server kept this size, in a status region. No request is sent and focus stays on the button.
### R18. Host dashboard re-render (Should)

Measure first: a React Profiler `onRender` probe on the values view under the compiled build the tests use. IF a clock tick alone costs a render of the values view, the following holds; IF the compiler already skips it, the measurement is recorded and nothing changes.

The values view SHALL not re-render when only the clock tick changed.
### R19. Mixed versions (decide by probe)

A script starts the previous release's server and drives terminal attach, resize and keybindings from the current client runtime. Pass: each call answers through its legacy path with no error. A failure becomes a fix in this batch.
### R20. Linux stalls and memory (decide by probe)

One packaged run in the Linux lab with the Profiler on, covering the settings to thread route change ten times. A `client.stall` or `memory.leak-*` finding with a trace becomes a diagnosis in this batch; without one, the run and its numbers are recorded and nothing changes.
- Item 8 (emoji widths): covered by R5.

**#354 Git leftovers**

### R21. Pull (record the limit)

The comment at `takes_index_lock` SHALL state D5.
### R22. Hooks (record the limit)

The comment at the forced-stop cleanup SHALL state that a lock taken while a hook runs is kept on Linux and macOS (the killed root did not hold it open), and that Windows can still remove a foreign lock under the 2-second rule. The existing test `index_lock_cleanup_keeps_a_lock_another_git_took_during_a_forced_write` is the proof.
### R23. Sign-in detector

The missing-username refusal SHALL be detected only on a line that starts with `fatal:` and contains both phrases.
- Given a commit message or hook output that contains both phrases on a line without `fatal:`, Then no sign-in guidance is shown.
- Given Git's line `fatal: could not read Username for 'https://gitlab.example.test': terminal prompts disabled`, with or without leading spaces and in any letter case, Then guidance is shown.
- Both callers' inputs are checked first: if either joins lines, the detector splits on that join as well.
### R24. Quiesce step documented

`docs/skills/bibcode-profiler/references/events.md` SHALL list `git-writes` among the `server.stop` quiesce steps, in its real position.
### R25. Test filters documented

`docs/testing/cross-platform-validation.md` SHALL list the `background_status_`, `git_stop_` and `index_lock_cleanup_` test filters.

**#355 Pull-request lookups**

### R26. Teardown

Quiesce SHALL wait for every running lookup to end before the profiler's teardown, and a lookup admitted after shutdown SHALL end at once as cancelled.
- Given a lookup whose child exits 200 ms after cancellation (injected), When shutdown is called, Then it returns only after that lookup has ended.
- The new quiesce step is documented with R24.
### R27. Failure backoff

WHEN a lookup fails, the same key SHALL answer with that failure for 5 seconds without starting a new lookup (D6), and the failure SHALL be logged once at `warn` without the remote's URL.
### R28. Expiry

WHEN a lookup fails and the last successful lookup for that branch is more than 5 minutes old, the remembered pull request SHALL stop being shown (D7). Without a failed lookup it stays, however old. A ref change clears it as today.
- Given a request remembered 6 minutes ago and a lookup that fails now, Then the next status has no pull request.
- Given a request remembered 6 minutes ago and no lookup since, Then it is still shown.
### R29. Late lookup with no subscriber (record the limit)

The doc comment at `spawn_for_subscribers` SHALL state D8.
### R30. Neutral change (decide by test)

A stream test invalidates during a lookup with a local change that alters no status. IF the answer from before the invalidation is shown with no follow-up lookup, a follow-up lookup SHALL be started; otherwise the test stays as proof.

**#356 Worktree creation records**

### R31. Delete by id

Creation rollback and removal SHALL delete the creation record by the id read when the worktree was created or resolved. Given a worktree recreated at the same path between resolve and delete, Then the new record survives.
### R32. Audit rollbacks

Both creation-rollback arms SHALL record a removal outcome with mode `create-rollback` and a fixed reason token, never a path. The mode is documented in the profiler events reference.
### R33. Unmounted volume

The audit SHALL reap a creation record only when its folder is missing and the folder's parent directory exists (D9).
- Given a record whose folder and parent directory are both missing (the volume is unmounted), Then the record is kept.
- Given a record whose folder is missing and whose parent directory exists, Then the record is reaped as today.
### R34. Creation record limits (record the limit)

Comments SHALL state that a record can outlive its worktree when another folder takes its path, that a worktree with no record is still recognized by its `.git` pointer file, that the pointer read checks the opened file (no check-then-open gap), and that containment covers only the last path component (D10).

**#357 Update install guard**

### R35. Reload

WHEN the window loads while a remote install it allowed is still protecting or installing, the unsaved-edits block SHALL be restored. A desktop without the state query counts as "not installing". A query that fails SHALL be retried and SHALL never release a block: only a confirmed state with no remote install in progress releases it.
- Given a reload during an allowed install and a first state query that rejects, Then saving stays held and the query is asked again; When it then answers that no remote install is in progress, Then the block ends.
### R36. Way out

WHEN the desktop's update state shows no remote install in progress, the installing dialog SHALL close even if the ended event never arrived. The dialog SHALL also offer a button that asks the desktop for the state again.
### R37. Late sources

A Files source registered during the install SHALL be held until the install ends.
### R38. Event names

A test SHALL fail when a `desktop:` event name exists on only one side of the bridge.
### R39. Toast reachability (decide by test)

A DOM test opens the installing dialog over the remote-update toast. IF the toast's action is inert, device management SHALL be usable while the installing dialog is up (reached from the dialog and shown above it, with Files saving still held); a callback that only navigates the page beneath the dialog does not meet this. Otherwise the test stays as proof.

**#358 Web and terminal**

### R40. Popup occlusion

On macOS desktop, an open Popover, Menu, Select, Combobox or Autocomplete popup SHALL hide a native browser preview only while its rectangle overlaps the preview's, and release it when it closes. Dialogs keep hiding the whole preview. Tooltips take no lease (D11).
### R41. Hand-over capability

The client SHALL apply the typed-last size hand-over rule only when the server advertises `terminalSizeHandOver`. A server without it gets the old behavior.
### R42. WebGL after a failure

A new terminal in the same viewport SHALL try WebGL again after an earlier context loss, and the fallback warning SHALL name the stage that failed (import failed, context lost) and the error's type name. It SHALL NOT carry raw error text: four existing tests require that, and raw text can hold paths.
### R43. Tall grid (decide by test)

A test records rows and mount height between mount and first snapshot after a reload. IF rows exceed the fitted rows, the terminal SHALL be fitted before it is shown; otherwise the result is recorded.
### R44. Flaky hint test (decide by runs)

`terminal_command_activity_hint_decodes_strictly_without_entering_launch_env` runs 50 times under CPU load. Any failure is diagnosed and fixed in this batch.
### R45. Pairing rejection

A rejected pairing SHALL be logged at `warn` with its reason and without the token.
### R46. Model picker

Reopening the composer's model picker SHALL show an empty search and the current values.
### R47. Read-only Markdown images

The read-only rendered Markdown view in Files SHALL load a relative image from the workspace through the same loader as the rich editor, and refuse a path that leaves the workspace. Chat messages are unchanged.

## Verification

- `cargo fmt --all --check`; `cargo clippy --workspace --all-targets -- -D warnings`; `cargo test -p bibcode-server`; `cargo test -p bibcode-desktop`.
- `vp check --no-fmt` on the whole tree and `vp check` on every changed file (the desktop app writes an ignored local settings file into an app-made worktree, which fails whole-tree formatting and is not part of the change; CI runs whole-tree `vp check` on a clean checkout); `vp run typecheck`; `vp run test`; `vp run check:contracts`; `vp run check:markdown-links`.
- Linux lab: the packaged default list with the Profiler on, plus the R20 run.
- Windows VM: `chat-reasoning-rows` (R12), the R13 runs, fmt, Clippy and `cargo test -p bibcode-server`.
- Review of changed React against `vercel-react-best-practices` and of changed UI against `UI.md`.

## Open questions

None that block planning. The agent's calls D4 to D13 are listed for the user with the plan's approval summary.
