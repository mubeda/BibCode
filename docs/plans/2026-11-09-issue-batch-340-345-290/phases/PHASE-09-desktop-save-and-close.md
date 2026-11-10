# Phase 9: Desktop save and close

- Goal: In the desktop app, Export saves a theme file through the native Save dialog, and closing the window, quitting, restarting or installing an update with unsaved Files edits asks first with Save all, Discard and Cancel, with a reviewed design note and tests (amendment A5; R53, R62).
- Round: 2
- Depends on: 6, 7
- Owns: `packages/contracts/src/ipc.ts`, `apps/web/src/tauriDesktopBridge.ts`, `apps/desktop/src-tauri/src/bridge.rs`, `apps/desktop/src-tauri/src/window.rs`, `apps/desktop/src-tauri/src/lib.rs` (command registration and the exit-request path), `apps/desktop/src-tauri/permissions/desktop-bridge.toml`, `apps/web/src/components/settings/AppearanceSettingsPanel.tsx` and its test (the export call only), `apps/web/src/proposedPlan.ts` and its test (the download helper only), `apps/web/src/components/files/fileEditingSessionRegistry.ts` and its test (the unsaved list and Save all only), a new `apps/web/src/components/files/UnsavedChangesCloseDialog.tsx` and its test, `apps/web/src/components/files/unsavedFileEdits.ts` and its test (create: the window-wide set of registries), `apps/web/src/components/ChatView.tsx` (registering its registry in that set only), `apps/web/src/routes/__root.tsx` (mounting the one close responder and dialog only), `apps/web/src/components/desktop/UpdateProtectionDialog.tsx` and the `restartApp` call sites (the unsaved check only), `docs/plans/2026-11-10-desktop-save-and-close-design.md`
- Must not touch: `apps/server/**` (Phases 3 to 5), `apps/web/src/index.css`, `apps/web/src/themes/**`, `apps/desktop/e2e/**` (Phase 8, Task 8.6), `docs/architecture/overview.md` (the coordinator writes its DesktopBridge paragraph at integration), `docs/plans/2026-11-09-issue-batch-340-345-290/**`
- Skills: test-driven-development (each behavior starts from a failing test); vercel-react-best-practices (AGENTS.md requires it for changed React components); better-accessibility (the close dialog and its focus order)
- Read first: `spec.md` R53 (desktop export scenario) and R62; `AGENTS.md` (Architectural Decision Standards: privileged desktop operations cross `DesktopBridge` commands and events); `apps/web/src/diagnostics/downloadDiagnosticLogs.ts` lines 155-240 and `apps/web/src/components/files/fileTransfers.ts` lines 10-60 (the existing bridge save patterns); `apps/web/src/components/files/fileEditingSessionRegistry.ts` (settle and the `"failed"` result); `apps/web/src/components/ChatView.tsx` near line 1810 (the registry owner) and near line 7279 (the conditional Files view); `apps/desktop/src-tauri/src/lib.rs` lines 280-330 (`ExitRequested` stops the embedded server at once; `Exit` without `ExitRequested` on Windows session end); `apps/desktop/src-tauri/src/bridge.rs` near line 1095 (`desktop_bridge_restart_app`) and `apps/desktop/src-tauri/src/updates.rs` lines 890-940 (the update install stops backends, then restarts); `docs/plans/2026-11-09-files-rich-markdown-toolbar-design.md` (delivery contract)
- Checkpoint: `cargo test -p bibcode-desktop -j 2` and, from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/components/files src/components/settings src/components/desktop src/proposedPlan.test.ts` exit 0. In the desktop app, Export opens the Save dialog, and closing with an unsaved edit shows the three-choice dialog.

Rust build slot: `bibcode-desktop` depends on `bibcode-server`, and `vp run check:contracts` runs `cargo test -p bibcode-server --test rpc_wire` (root `package.json` line 33). Every step that runs cargo, `vp run check:contracts`, workspace Clippy or desktop tests runs only when no other lane compiles Rust. Tasks 9.1 (web and contract code) and 9.2 are TypeScript and may run beside a server phase; their cargo and contract-check steps wait for the slot. Task 9.3 is Rust and waits for the slot. The phase starts from the integrated round 1 branch.

The design note (Task 9.1 step 1) must decide, each with a test or a stated limit:

1. Every exit path: window close, the Close Window menu action, app quit and `RunEvent::ExitRequested`, `desktop_bridge_restart_app`, update install, relaunch, and OS session end. Window close and quit ask through the native close protocol (Task 9.3). Restart and update install appear to start only from the web through bridge calls (`restartApp`, `installUpdate`); confirm it with `rg "request_restart|\.restart\(|relaunch" apps/desktop/src-tauri/src` (on 2026-11-10 that found `bridge.rs` line 1104 and `updates.rs` line 935, inside the web-started install) and check `remote_update_delegate.rs` and `windows_update_restart.rs`; any native-started restart is guarded natively instead. OS session end (Windows `Exit` without `ExitRequested`, macOS logout) cannot wait for the person and is outside R62.
2. An escape so the app can never become unclosable, without silently discarding edits: when the desktop asks the web and gets no acknowledge within a few seconds, or keepalives stop after an acknowledge (the renderer crashed, reloaded or hung), the desktop must still let the person close. Compare closing with a logged warning against a native prompt ("Close anyway" or "Keep waiting", with the dialog plugin `bridge.rs` line 14 already imports), choose one, and test it, including a minimized or hidden window where the webview may throttle timers. While keepalives arrive, the desktop waits for the person with no timeout.
3. Approval happens before anything irreversible: the desktop must hold a close or quit before `ExitRequested` stops the embedded server (`lib.rs` line 286), and Cancel must leave the server and the window usable.
4. "Unsaved" includes an edit still inside the 300 ms rendered-view delay and an undelivered edit; typing and closing at once shows the dialog.
5. A save that fails for any reason (a disk conflict or another error) keeps the window open and shows the error on that file.
6. One close responder per window, mounted in the root route (`__root.tsx`), so it exists on every route, including Settings. Every `FileEditingSessionRegistry` (the host `ChatView` and each panel `ChatView`, `ChatView.tsx` lines 994 and 1780) registers in a window-wide set while it owns sessions and leaves it on dispose; the responder asks every registered registry, so a clean panel can never allow a close while the host has unsaved edits, and with no registry the close proceeds at once.
7. The end-to-end seam for Export bypasses only the native picker (for example a save path honored only in the end-to-end build) and keeps the real command and write; the note says why it cannot be used outside that build.

## Tasks

### Task 9.1: Export a theme and a plan through the native Save dialog

- Satisfies: R53 (export in the desktop app)
- Depends on: none
- Files: create `docs/plans/2026-11-10-desktop-save-and-close-design.md`; modify `packages/contracts/src/ipc.ts`; modify `apps/web/src/tauriDesktopBridge.ts`; modify `apps/desktop/src-tauri/src/bridge.rs`; modify `apps/desktop/src-tauri/src/lib.rs`; modify `apps/desktop/src-tauri/permissions/desktop-bridge.toml`; modify `apps/web/src/components/settings/AppearanceSettingsPanel.tsx` and its test; modify `apps/web/src/proposedPlan.ts`; create or modify `apps/web/src/proposedPlan.test.ts`
- Interfaces: produces a `DesktopBridge` method `saveTextFile(input: { suggestedName: string; contents: string; mimeType: string }): Promise<string | null>` (the saved path, `null` when the person cancels, a rejection for a failed write), its adapter in `tauriDesktopBridge.ts`, its permission entry and its Tauri command. The theme export and `downloadPlanAsTextFile` call it when `window.desktopBridge?.saveTextFile` exists and keep the blob link in browser mode. `downloadPlanAsTextFile` handles a rejection itself and reports it through the existing toast, because its two callers (`PlanSidebar.tsx`, `ProposedPlanCard.tsx`) ignore its result.
- Skills: none
- Read first: the diagnostics save path named in the phase's Read first line
- Tier: most capable
- TDD: red-green
- Done when: from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/components/settings/AppearanceSettingsPanel.test.tsx src/proposedPlan.test.ts` exits 0 with the new tests passing, and, in the Rust slot, `cargo test -p bibcode-desktop -j 2 save_text_file` exits 0

Steps

1. [ ] Write the design note covering the seven decisions above, the new bridge parts (this command, Task 9.3's close request and reply), the alternatives considered (a Tauri download handler, clipboard export, a `beforeunload`-only guard) and why they lost, and the trust boundary (the command writes only to a path the person picked in the native dialog, or to the end-to-end seam path in the end-to-end build). Get a read-only Codex review and an advisor review, process both with `receiving-review.md`, list each finding under "Review handling", and set `Status: Approved 2026-11-10 (pre-approved: reviewed by Codex and the advisor)`.
2. [ ] Add web tests: in `AppearanceSettingsPanel.test.tsx`, `Export in the desktop app saves through the bridge with <id>.theme.json`, `a cancelled save writes nothing and shows no error`, `a failed save shows an error`, and `Export in the browser keeps the download link`; in `proposedPlan.test.ts`, the same four cases for `downloadPlanAsTextFile`. Run the Done when web command. Expected: FAIL, the bridge is not called.
3. [ ] Implement the contract method, the adapter, the two web call sites and the helper's error handling. Run the Done when web command. Expected: PASS.
4. [ ] In the Rust slot: add `save_text_file_writes_the_contents_to_the_chosen_path`, `save_text_file_returns_none_when_cancelled` and `save_text_file_reports_a_failed_write` with the dialog behind a test seam. Run `cargo test -p bibcode-desktop -j 2 save_text_file`. Expected: FAIL to compile. Implement the command, its registration and the permission entry. Run it again. Expected: PASS.
5. [ ] Prove the tests can fail: make the theme export ignore the bridge, run the web command. Expected: FAIL. Restore and run again. Expected: PASS.
6. [ ] In the Rust slot: run `vp run check:contracts`, `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings`. Expected: no errors, and no fixture diff or a regenerated fixture committed with the change.

### Task 9.2: Ask before leaving with unsaved Files edits (web)

- Satisfies: R62 (save all, a save is blocked, discard and cancel, nothing unsaved, browser mode)
- Depends on: 9.1
- Files: modify `apps/web/src/components/files/fileEditingSessionRegistry.ts` and its test; create `apps/web/src/components/files/unsavedFileEdits.ts` and its test; create `apps/web/src/components/files/UnsavedChangesCloseDialog.tsx` and its test; modify `apps/web/src/components/ChatView.tsx`; modify `apps/web/src/routes/__root.tsx`; modify `apps/web/src/components/desktop/UpdateProtectionDialog.tsx` and the `restartApp` call sites; modify the design note
- Interfaces: consumes the registry's sessions, `flush()` and `settle()` with their `"failed"` result, and the pending-edit flusher; produces `unsavedSessions(): { path: string }[]` (an edit inside the 300 ms delay and an undelivered edit count as unsaved), `saveAll(): Promise<"saved" | "blocked">`, `askBeforeLeaving(reason: "close" | "quit" | "restart" | "update"): Promise<"proceed" | "stay">` (shows the dialog when anything is unsaved), `registerUnsavedSource(registry): () => void` and `windowUnsavedFiles(): { path: string }[]` in `unsavedFileEdits.ts` (the window-wide set; `askBeforeLeaving` and `saveAll` work across every registered registry), and the dialog with props `{ files: string[]; onSaveAll(): void; onDiscard(): void; onCancel(): void }`, mounted once in `__root.tsx`. Restart and update install call `askBeforeLeaving` before their bridge call. In browser mode the registry adds a `beforeunload` warning while anything is unsaved.
- Skills: better-accessibility (the dialog's focus lands on Save all and Escape cancels)
- Read first: `apps/web/src/components/desktop/UpdateProtectionDialog.tsx` (the existing update confirmation)
- Tier: most capable
- TDD: red-green
- Done when: from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/components/files src/components/desktop` exits 0 with the new tests passing

Steps

1. [ ] Add tests: `Save all writes a rendered and a source edit and proceeds`, `Save all with a file changed on disk stays and shows the reload-or-overwrite choice`, `a save that fails for another reason stays and shows the error`, `Discard proceeds without writing`, `Cancel stays and keeps the edits`, `nothing unsaved proceeds at once without a dialog`, `typing in rendered view and leaving at once shows the dialog`, `the guard works while the Files view is not mounted`, `a clean panel registry cannot allow a close while the host registry has an unsaved edit`, `on a Settings route with no registry the close proceeds at once`, `restart and update install ask first`, and `browser mode warns before unload only while an edit is unsaved`. Run the Done when command. Expected: FAIL.
2. [ ] Implement the registry methods, the window-wide set and each registry's registration, the dialog and its single mount in `__root.tsx`, and the restart and update checks.
3. [ ] Run the Done when command. Expected: PASS.
4. [ ] Prove the tests can fail: make `saveAll` report `"saved"` without saving. Expected: FAIL. Restore. Expected: PASS.
5. [ ] Review the dialog and the mount against `vercel-react-best-practices` and `UI.md`, and record both results for the final report.

### Task 9.3: The native close protocol

- Satisfies: R62 (window close and quit ask through the web; the escape rule; Cancel keeps the server usable)
- Depends on: 9.2
- Files: modify `apps/desktop/src-tauri/src/window.rs`; modify `apps/desktop/src-tauri/src/lib.rs`; modify `apps/desktop/src-tauri/src/bridge.rs`; modify `packages/contracts/src/ipc.ts`; modify `apps/web/src/tauriDesktopBridge.ts`; modify `apps/web/src/routes/__root.tsx` (the subscription only); modify the design note
- Interfaces: consumes `askBeforeLeaving` (Task 9.2); produces a desktop close-request event (with a request id) and a reply command (`acknowledge`, `keepalive`, `allow` or `stay`), the window-close and Close Window menu interception, and the quit interception that holds `ExitRequested` (`api.prevent_exit()`) before the embedded server stops, then exits once the web allows it.
- Skills: none
- Read first: `apps/desktop/src-tauri/src/lib.rs` lines 280-330 and `window.rs` lines 60-90
- Tier: most capable
- TDD: red-green
- Done when: in the Rust slot, `cargo test -p bibcode-desktop -j 2 close_request` exits 0, and, from `apps/web`, the Task 9.2 command still exits 0

Steps

1. [ ] Add Rust tests: `close_request_waits_for_the_web_answer`, `close_request_closes_when_the_web_allows_it`, `close_request_keeps_the_window_and_the_server_when_the_web_says_stay`, `close_request_escapes_when_the_web_never_acknowledges`, `close_request_escapes_when_keepalives_stop_after_an_acknowledge` (both per the escape the design note chose), `close_request_on_quit_waits_for_the_web_before_the_server_stops`, and `close_request_on_quit_cancel_keeps_the_server_answering` (after Cancel a server request still succeeds). Run `cargo test -p bibcode-desktop -j 2 close_request`. Expected: FAIL to compile.
2. [ ] Implement the event, the reply command and its permission, the interceptions and the escape rule; subscribe once in `__root.tsx` through the adapter.
3. [ ] Run both Done when commands. Expected: PASS.
4. [ ] Prove the tests can fail: make the reply ignore `stay`, and separately let the quit path stop the server before the answer. Expected: FAIL each time. Restore. Expected: PASS.
5. [ ] Run `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `vp run check:contracts` and `vp run check:markdown-links`. Expected: no errors.
