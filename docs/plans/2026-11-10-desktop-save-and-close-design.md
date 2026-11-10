# Desktop save and close

Status: Approved 2026-11-10 (pre-approved: reviewed by Codex and the advisor)

Amendment A5 of [the batch spec](./2026-11-09-issue-batch-340-345-290/spec.md): R53 (export in
the desktop app) and R62 (asking before leaving with unsaved Files edits). Plan phase:
[Phase 9](./2026-11-09-issue-batch-340-345-290/phases/PHASE-09-desktop-save-and-close.md).
Verified against the integration branch at `6d3748b05`, Tauri 2.11.6, tauri-runtime-wry 2.11.4,
tao 0.35.3 (git `c704261`) and muda 0.19.3. Line references are to those sources.

## Problem and scope

Wry cancels a webview download when the host installs no download handler, so the theme
Export button and the plan download do nothing in the desktop app. The desktop app also closes,
quits, restarts and installs updates without asking, so an unsaved Files edit is lost.

This change adds one bridge command that saves text through the native Save dialog, and one
close protocol through which the desktop asks the web before the main window closes or the app
quits. The web asks the same question itself before it restarts the app or installs an update.

## New bridge parts

| Part                                 | Direction      | Shape                                                                             |
| ------------------------------------ | -------------- | --------------------------------------------------------------------------------- |
| `desktop_bridge_save_text_file`      | web to desktop | `{ suggestedName, contents }` to the saved path, `null` on Cancel, or a rejection |
| `desktop:close-request` event        | desktop to web | `{ requestId: number, reason: "close" \| "quit" }`                                |
| `desktop_bridge_reply_close_request` | web to desktop | `{ requestId, reply: "acknowledge" \| "keepalive" \| "allow" \| "stay" }`         |
| `desktop:update-install-ended` event | desktop to web | no payload, after an allowed `update` request ends without a restart              |

`DesktopBridge` gains `saveTextFile(input)`, `onCloseRequest(listener)`,
`replyCloseRequest(requestId, reply)` and `onUpdateInstallEnded(listener)`, all optional so the browser build has none of them.
Both commands go into the `allow-desktop-bridge` permission, the `generate_handler!` list and
the audited command lists in `lib.rs` and the `bridge.rs` tests. The event goes to the main
window (`MAIN_WINDOW_LABEL`) only, and the close handler is installed on the main window only,
so a preview window's close (`preview/platform/linux.rs:392`) is not intercepted.

## Decisions

### 1. Exit paths

| Path                                           | How it starts                                                           | Guard                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| Window close button, Alt+F4                    | `WindowEvent::CloseRequested`                                           | close protocol, reason `close`                                  |
| Window > Close Window                          | `window.close()` (`window.rs:79`), which emits `CloseRequested`         | close protocol, reason `close`                                  |
| File > Quit (Exit on Windows), Cmd+Q on macOS  | today the predefined `.quit()` item (`window.rs:104`)                   | a BiBCode menu item that runs the close protocol, reason `quit` |
| Last window destroyed                          | `ExitRequested { code: None }` (tauri-runtime-wry `lib.rs:4316`)        | none needed, because it follows an approved close               |
| `desktop_bridge_restart_app`                   | web `restartApp` (`bridge.rs:1104`)                                     | the web asks first (Task 9.2)                                   |
| Update install from this window                | web `installUpdate`, then `app.restart()` (`updates.rs:935`)            | the web asks first (Task 9.2)                                   |
| Update install requested by another device     | server RPC `updater.install`, `remote_update_delegate.rs:146` and `200` | close protocol, reason `update`, before `install_update`        |
| Dock Quit and the app switcher's Quit on macOS | `terminate:`, then `RunEvent::Exit`                                     | outside R62 (stated limit, user decision)                       |
| SIGTERM on Unix                                | `backend.rs:2060` stops the backend, then `app.exit(0)`                 | none, because the OS is ending the app                          |
| Windows session end, macOS logout              | `RunEvent::Exit` without `ExitRequested`                                | outside R62                                                     |

Two facts in the pinned sources shape the quit path.

- The predefined Quit item never reaches `ExitRequested`. muda maps it to `terminate:` on macOS
  (`muda-0.19.3/src/platform_impl/macos/mod.rs:994`) and to `PostQuitMessage(0)` on Windows
  (`windows/mod.rs:1224`). Tao implements `applicationWillTerminate` only
  (`app_delegate.rs:131`), which sends `LoopDestroyed`, and tauri-runtime-wry turns that into
  `RunEvent::Exit` (`lib.rs:4185`). No `ExitRequested` handler can hold it, so `prevent_exit()`
  is the wrong tool. The menu gets its own Quit item (id `bibcode:quit`) with the predefined
  item's label and accelerator (`&Exit` on Windows, `&Quit` elsewhere, and `CmdOrCtrl+Q` on
  macOS only, `muda-0.19.3/src/items/predefined.rs:291` and `339`), so no new shortcut reaches
  Windows or Linux, where Ctrl+Q belongs to the terminal. It runs the close protocol and calls
  `app.exit(0)` only after `allow`. That exit raises `ExitRequested`, whose existing handler
  (`lib.rs:286`) stops the embedded server. So the server stops only after the web allowed the
  quit, and Cancel touches nothing.
- Tauri decides `CloseRequested` and `ExitRequested` synchronously with `try_recv`
  (tauri-runtime-wry `lib.rs:4318`, `4361` and `4462`). The close handler therefore calls
  `api.prevent_close()` at once, and the desktop later calls `window.destroy()`, which emits no
  second `CloseRequested` (Tauri `window/mod.rs:1798`).

Holding `ExitRequested` itself is rejected, because it would also hold the SIGTERM exit, which arrives
after the backend stopped, so Save all could not work there. Restart cannot be held either,
because `prevent_exit()` ignores `RESTART_EXIT_CODE` (Tauri `app.rs:91`).

As a side effect, Quit on macOS and Windows now runs the same `ExitRequested` teardown as a window
close (window state saved, backend stopped, `note_exit("quit")`). Today it skips it, and on
Windows that exit takes the session-end branch (`lib.rs:305`). This is inferred from the
sources and is checked by the packaged run in Task 8.6.

Proven by the Rust tests `close_request_on_quit_waits_for_the_web_before_the_server_stops` and
`close_request_closes_when_the_web_allows_it`, the web test `restart and update install ask
first`, and Task 8.6's packaged close cases.

An update install that another device requests through the server's `updater.install` starts
natively and restarts the app (`remote_update_delegate.rs:200`, then `updates.rs:935`). After the
download and before `install_update`, `run_remote_install` asks this window through
`CloseGuard::ask_before_update` (reason `update`) and installs only on `allow`. `stay` logs a
`tracing::warn!` line and leaves the update downloaded. The question waits for the person like a
local install does, so a remote install waits while nobody answers the open dialog. Proven by
`close_request_on_remote_update_proceeds_only_when_the_web_allows_it` and
`close_request_remote_install_asks_the_window_first`.

The backup, protection and install run for a long time after `allow`, and the restart at the
end asks nothing. So once the web allows an `update` request (Save all succeeded, Discard, or
nothing was unsaved), it holds saving in every registry and shows a modal "Installing an update"
dialog with no buttons, which Escape does not close. Edits made after the answer are therefore
neither typed nor written. Only the remote path sends reason `update`; the local install in
`UpdateProtectionDialog` keeps its own `releaseLeaveHolds()` handling.

The existing `desktop:update-state` event cannot end that block. The `accepted: false` returns
of `install_update` (backend recovery pending, an install in flight) change no state and emit
nothing, and the clearing of `requestedBy` also fires on exits before the window was asked. So
`install_after_allow` arms an `AllowedInstall` guard after `allow`. Its `Drop` emits
`desktop:update-install-ended` to the main window on every return unless the result had
`completed: true`, which restarts the app (on Windows the installer ends it). The web then
releases the block's holds and any Discard holds, closes the dialog and shows "The update did not
install". Proven by `close_request_remote_install_signals_every_end_without_restart_after_allow`
and the web tests under "a remote update install the window allowed". Limit: when the person
picks "Close anyway" in the native prompt for an `update` request, the web did not answer and is
not blocked, as for any request the person forces.

Dock Quit and the app switcher's Quit on macOS send `terminate:`, and tao has no
`applicationShouldTerminate` hook, so they cannot wait for an answer. The user decided on
2026-11-10 that they are a stated limit of R62, like logging out, and the spec says so.

Quit with nothing unsaved now runs the `ExitRequested` teardown (above). Task 8.6 adds the case
"Quit with nothing unsaved exits promptly", and the Rust slot confirms the teardown with a test
or a probe.

### 2. Escape when the web does not answer

The desktop keeps one pending request with a deadline.

- On a request it unminimizes, shows and focuses the main window, then emits the event. The
  person must see the dialog, and a visible page is not throttled.
- Without an `acknowledge` within 5 seconds, or without a `keepalive` for 5 seconds after an
  acknowledge, the deadline passes.
- The web sends keepalives only while `UnsavedChangesCloseHost` is mounted and holds the
  request (the dialog is open or Save all runs). When the host unmounts with a request pending,
  it answers `stay` and stops the keepalives. So a running timer alone cannot keep the desktop
  waiting on a page that no longer shows the question. A keepalive every second gives a
  throttled timer five chances.
- When the deadline passes, the desktop shows a native prompt through the dialog plugin:
  "BiBCode is not responding. Unsaved Files edits may be lost." with "Close anyway" and "Keep
  waiting". Close anyway leaves as if the web had allowed it. Keep waiting starts a new
  5-second wait on the same request.
- An answer from the web that arrives while the prompt is open still decides the request. The
  prompt's later answer is then ignored, because the request is gone.
- The deadline passing and Close anyway each log a `tracing::warn!` line.

Closing with a logged warning instead was rejected. A hung renderer still holds the edits in
memory, and a silent close would drop them without the person's say. The prompt costs one native
dialog in the rare case that the web is gone. The prompt sits behind a seam, so tests answer it.

While keepalives arrive, the desktop waits for the person with no timeout.

Proven by `close_request_escapes_when_the_web_never_acknowledges`,
`close_request_escapes_when_keepalives_stop_after_an_acknowledge` and the web test that an
unmounted host answers `stay`. The unminimize, show and focus step is a stated limit, because it has no
unit seam, and Task 8.6's packaged run exercises it with a visible window only.

### 3. Approval before anything irreversible

Nothing stops before `allow`. Close destroys the window only after `allow` (or Close anyway), and
Quit calls `app.exit(0)` only after `allow`. `stay` clears the request and leaves the window, the
webview and the embedded server as they are. A second close or quit while a request is pending
joins it. A reply with a stale `requestId`, or any reply with no request pending, is dropped.
Restart and update install call `askBeforeLeaving` before their bridge call, so the native work
starts only after the answer.

Proven by `close_request_keeps_the_window_and_the_server_when_the_web_says_stay` and
`close_request_on_quit_cancel_keeps_the_server_answering`. Desktop unit tests cannot start the
embedded server (its test helpers are private to `backend.rs`), so the second test asserts that
the leave action, the only path to the `ExitRequested` teardown, never runs after `stay`.
Task 8.6's packaged Cancel case proves that a later server request succeeds.

### 4. What counts as unsaved

A session is unsaved when `unsavedContents !== null` (a pending, saving, failed or paused
write) or `getSnapshot().editPending` is true. The rendered view sets its pending-edit flusher on
the first keystroke and clears it when it delivers (`RichMarkdownSurface.tsx:50` and `73`), so an
edit still inside the 300 ms delay counts, and an edit whose delivery threw keeps the flusher
and stays unsaved. `ManagedFileEditingSession` gains these two members, which
`FileEditingSession` already has. A session in a failed close stays in the registry and counts.

An IME composition is not in the document until `compositionend`. `askBeforeLeaving` first blurs
the focused element and waits one task, which makes the webview commit the composition into
the editor before the registries are read (inferred from browser behavior, not run in a real
IME).

A registry that is disposing (its `ChatView` unmounted, for example on the way to Settings)
keeps the sessions it is settling in `unsavedSessions()` until each settle ends, and Save all
waits for those settles. A session whose settle fails during that dispose is disposed as today
and is not listed afterwards. That loss happens on navigation, before any close, and is outside
this change.

Proven by the registry tests for a rendered edit in its delay, an undelivered edit and a
disposing registry, and the dialog test `typing in rendered view and leaving at once shows the
dialog`.

### 5. A save that fails

Save all calls `settle()` on every session of every registered registry, in parallel. `settle()`
delivers a pending rendered edit, waits for a write in flight and writes the rest. A `"failed"`
result or a rejection (caught per session, so every settle finishes) makes Save all report
`"blocked"`, and then:

- the dialog, which shows "Saving..." while the settles run, closes, the window stays open and
  the leave is answered `stay`;
- a toast lists the files that are still unsaved;
- a file refused because it changed on disk shows the existing reload-or-overwrite bar, because
  the session set its conflict while saving;
- a file refused for another reason shows the existing "Save failed, retry" state on its Save
  button (`FileEditorToolbar.tsx:126`).

`settle()` also reports `"failed"` while saving is paused (the workspace is unavailable or a
rename holds the path). Those cases block the same way.

When the dialog opens, every registry takes a leave hold, which pauses saving (clearing every
debounce timer) and wins over `setSavingEnabled(true)` and a rename's release. A write already
in flight when the question appears finishes, because a request cannot be recalled. Cancel
releases the hold. Save all releases it and then settles. Discard keeps it, so no write starts
between Discard and the exit. If a restart or install is refused after Discard, the caller
releases the hold, and the edits are still unsaved and still shown.

Proven by the dialog tests for Save all, a disk conflict, another failure, Discard and Cancel,
and the registry test for the leave hold.

### 6. One responder per window

`unsavedFileEdits.ts` holds the window-wide set. A `FileEditingSessionRegistry` joins it when it
creates its first session and leaves it when its dispose finishes, so the host `ChatView` and each
panel `ChatView` (`ChatView.tsx:994` and `1780`) are covered without code in `ChatView`.
`askBeforeLeaving(reason)` reads every registered registry, so a clean panel cannot answer for a
host with edits. With nothing unsaved it resolves `"proceed"` at once and shows no dialog. One
pending call is shared, so a second call while the dialog is open gets the same answer.

`UnsavedChangesCloseHost` renders the dialog and subscribes to the desktop close request. It is
mounted once in every branch of `RootRouteView` (`/pair`, the auth gate and the app shell) and in
`RootRouteErrorView`, so every page acknowledges and answers. A route with no registry, such as
Settings, answers `allow` at once.

In browser mode the set adds one `beforeunload` listener that prevents the default only while a
registered registry has an unsaved session. It does nothing in the desktop app, where the close
protocol asks.

Proven by the tests `a clean panel registry cannot allow a close while the host registry has an
unsaved edit`, `on a Settings route with no registry the close proceeds at once`, `the guard
works while the Files view is not mounted` and `browser mode warns before unload only while an
edit is unsaved`.

### 7. Export and its end-to-end seam

`saveTextFile` validates the name (plain, at most 255 bytes, with an extension) and the contents
(at most 8 MiB), opens the Save dialog with that name, the file's extension as the only filter and
the Downloads folder, and writes the contents to the chosen path. Cancel returns `null`. A write
error rejects with the error text and logs a `tracing::warn!` line, and the caller shows it: the
Appearance panel through a toast, and `downloadPlanAsTextFile` through the same toast because its
two callers ignore its result. In the browser both keep today's blob link.

In a build with the `desktop-e2e` feature only, `BIBCODE_E2E_SAVE_TEXT_PATH` replaces the picked
path. The command, its validation and the write stay real. A release build compiles without the
feature, so no environment variable can redirect a write there.

Trust boundary: the command writes only to a path the person picked in the native dialog, or to
that variable's path in an end-to-end build. The web supplies only the suggested name, which
cannot carry a directory.

Proven by `save_text_file_writes_the_contents_to_the_chosen_path`,
`save_text_file_returns_none_when_cancelled`, `save_text_file_reports_a_failed_write` and the four
web export cases each for the Appearance panel and `downloadPlanAsTextFile`.

### 8. Ending an end-to-end session with an unsaved edit

Every packaged spec ends by calling `desktop_e2e_prepare_for_exit` and then closing the window
(`apps/desktop/e2e/support/app-lifecycle.ts:29`). A spec that leaves an edit unsaved (Task 8.1
types edits), or whose renderer died, would then wait on the dialog or the native prompt.

`desktop_e2e_prepare_for_exit` disarms the `CloseGuard` first, so every later close or quit
leaves at once, as if allowed. The command exists only in a `desktop-e2e` build, and so does
`CloseGuard::disarm`.

The other choice, the lifecycle helper answering Discard through WebDriver, was rejected. It
needs a responsive renderer, so a dead or hung page still meets the native prompt, which WebDriver
cannot drive. It also needs the helper to know whether a dialog will appear, which makes every
teardown depend on the dialog's timing. The disarm needs no knowledge of the spec's edits and no
dialog. Limit: the helper reaches `desktop_e2e_prepare_for_exit` through `browser.execute`
(`app-lifecycle.ts:35`), so it still needs a renderer that runs scripts. A hung renderer blocks
that teardown before and after this change, and handling it needs a native route that Task 8.6
owns.

The close cases of Task 8.6 (Save all, Discard, Cancel and a clean close) close the window
before they call the teardown, so they exercise the real protocol. Proven by
`close_request_disarmed_for_end_to_end_teardown_leaves_at_once`. Task 8.6 runs it in the
packaged app.

## Rulings against the phase text

- Ruling: the quit is held before `app.exit(0)` in a BiBCode Quit menu item, not with
  `prevent_exit()` in `ExitRequested` as Task 9.3's Interfaces line says, because the predefined
  Quit item never raises `ExitRequested` and the SIGTERM exit does. Cost if wrong: a future
  `app.exit` call skips the question. Task 9.3's prove-fail step mutates `CloseGuard`, which the
  `close_request_*` tests drive. The menu item and the `CloseRequested` handler that call it have
  no unit seam, so only Task 8.6's packaged run proves that wiring.
- Ruling: `saveTextFile` takes no `mimeType`, because the native dialog filters by extension and
  the browser path never reaches the bridge, so nothing would read it. Cost if wrong: one
  optional field to add.
- Ruling: `close_request_on_quit_cancel_keeps_the_server_answering` asserts that the teardown
  never runs, not that a server request succeeds, because desktop unit tests cannot start the
  server. Task 8.6's packaged Cancel case proves the request. Cost if wrong: a regression in the
  teardown order shows only in the packaged run.
- Ruling: registries join the window-wide set themselves, so `ChatView.tsx` needs no change,
  because a registry knows when it starts owning sessions and when its dispose ends, and an
  effect cleanup in `ChatView` runs before the dispose settles. Cost if wrong: none for the
  behavior, and `ChatView.tsx` stays untouched.
- Ruling: `unsavedContents` and `getSnapshot` are optional on `ManagedFileEditingSession`, because
  session fakes in `ChatView.test.tsx` and `FileBrowserPanel.test.tsx`, which Phase 9 does not own,
  lack them. A session without them counts as saved. Cost if wrong: a future session type that
  omits them is never asked about.
- Ruling: the dialog has a `saving` prop beyond the phase's four, and it stays open with every
  choice disabled while Save all runs, because UI.md asks for visible progress. Cost if wrong:
  one prop to remove.
- Ruling: the desktop subscription lives in `UnsavedChangesCloseHost`, which `__root.tsx` mounts,
  not in `__root.tsx` itself, so the keepalives stop with the host (decision 2). Cost if wrong:
  none for the behavior.
- Ruling: `buildProposedPlanMarkdownFilename` caps the title part at 120 characters, because a long
  plan title would otherwise fail the 255-byte name rule with an error the person cannot act on.
  Cost if wrong: long plan file names are shorter than before.

## Alternatives

- A Tauri download handler that saves blob downloads. It would need a host policy for every
  download the webview starts, including ones a previewed page starts, to cover two buttons.
- Copying the JSON to the clipboard. R53 asks for a file, and the person must paste it somewhere.
- A `beforeunload`-only guard. A page cannot offer Save all, Discard and Cancel from it, and a
  native close or quit destroys the webview without a page navigation (inferred, not run).
- Holding `ExitRequested` with `prevent_exit()` (decision 1).
- Closing with a logged warning when the web stops answering (decision 2).

## Test plan

Web (Vitest, from `apps/web`):

- `AppearanceSettingsPanel.test.tsx` and `proposedPlan.test.ts`: the desktop save, Cancel, a
  failed save and the browser link.
- `fileEditingSessionRegistry.test.ts`: `unsavedSessions` with a pending rendered edit, an
  undelivered edit and a disposing registry, `saveAll` saved and blocked, the leave hold, and
  joining and leaving the window-wide set.
- `unsavedFileEdits.test.ts`: the window-wide set, a clean panel beside an unsaved host, no
  registry, the shared pending call and `beforeunload` in browser mode.
- `UnsavedChangesCloseDialog.test.tsx`: Save all, a disk conflict, another failure, Discard,
  Cancel, nothing unsaved, typing and leaving at once, the Files view unmounted, focus on Save
  all and Escape as Cancel, an unmounted host answering `stay`, and the desktop close request
  answered through a fake bridge.
- `UpdateProtectionDialog` tests: restart and update install ask first.

Rust (`cargo test -p bibcode-desktop`): `save_text_file_*` through a seam for the chosen path,
and `close_request_*` against the pure request state machine with an injected clock, a recorded
leave action and a scripted prompt.

End-to-end teardown: decision 8.

## Open questions

None. The remote update install and Dock Quit were resolved on 2026-11-10 (decision 1).

## Review handling

Codex `gpt-6.1-sol`, effort high, read-only, one round. Verdict "Needs rework", seven findings.

1. Remote update install is unguarded. Accepted. The coordinator granted
   `remote_update_delegate.rs` for this change, and decision 1 now guards it.
2. Dock Quit is not a session end. Accepted. The user decided on 2026-11-10 that it is a stated
   limit of R62, and decision 1 records it.
3. An IME composition counts as saved. Checked: `setComposing` keeps the flag private
   (`fileEditingSession.ts:303`), and Pierre applies composed text at `compositionend`. Fixed in
   decision 4: `askBeforeLeaving` blurs the focused element and waits one task before it reads
   the registries.
4. Pausing cannot stop a write already in flight. Checked: `pauseSaving` clears only the timer
   (`fileSaveCoordinator.ts:162`). Fixed in decision 5: the hold starts when the dialog opens, so
   Discard starts no write, and a write in flight before the question is stated.
5. A disposing registry drops out before its settle ends. Checked: `disposeInternal` removes
   sessions before it awaits them (`fileEditingSessionRegistry.ts:248`). Fixed in decisions 4 and
   6: registries join and leave the set themselves, and settling sessions stay listed.
6. A rejected settle is not defined. Checked: `settle()` can reject through `persistLatest`.
   Fixed in decision 5: each settle is caught and counts as a failure.
7. `mimeType` is missing. Accepted as a deviation and recorded as a Ruling.

Advisor, one round, nine findings.

1. Keepalives can outlive the dialog. Fixed in decision 2: keepalives run only while the host is
   mounted and holds the request, and an unmount answers `stay`.
2. Three deviations are not marked. Fixed: the Rulings section lists them, plus the registry
   joining the set itself.
3. `CmdOrCtrl+Q` adds Ctrl+Q on Windows and Linux. Checked in muda (`predefined.rs:339`): the
   predefined accelerator is macOS only. Fixed in decision 1.
4. Scope to the main window. Fixed in the bridge parts section.
5. Discard is unverified. Checked: `change()` does not schedule while paused
   (`fileSaveCoordinator.ts:68`), and `dispose()` writes nothing while paused (line 124).
   `ChatView` can call `setSavingEnabled(true)` again, so Discard uses a leave hold that wins over
   it (decision 5).
6. No proof per decision. Fixed: each decision ends with its proof or a stated limit.
7. The error must show on the file. Fixed in decision 5 with the existing Save button state.
8. Profiler coverage. Fixed: decisions 2 and 7 name their `tracing::warn!` lines. The protocol
   spawns no process and adds no RPC method.
9. Packaged teardown passes through the protocol. Recorded in the test plan for Task 8.6.

Codex `gpt-6.1-sol`, effort high, a second read-only pass on the delta (decisions 1 and 8).
Verdict "Needs rework", two P2 findings, and no finding on the remote install guard, the guard's
state, the end-to-end feature gate or compile defects.

1. R62 lacks the Dock Quit exemption. Checked: this worktree's copy of `spec.md` predates it, and
   the integration branch's `spec.md` line 1004 lists quitting from the Dock or the app switcher
   as outside R62. Rejected: the spec already says so.
2. Decision 8 overstated dead-renderer coverage. Checked: the helper calls the command through
   `browser.execute` (`app-lifecycle.ts:35`). Fixed: decision 8 states the limit.

Codex review of the Phase 9 code, triaged by the coordinator and the advisor, two findings.

1. (P1) Edits made after the person allowed a remote install were lost at its restart. Fixed:
   the web blocks Files editing and holds saving from the answer until the restart or
   `desktop:update-install-ended` (decision 1).
2. (P2) After Discard, a failed remote install left saving paused. Fixed: the same signal
   releases the Discard holds.

Decision 8 was added on 2026-11-10 at the coordinator's request, because the phase file's edit
that should have listed it was missed.
