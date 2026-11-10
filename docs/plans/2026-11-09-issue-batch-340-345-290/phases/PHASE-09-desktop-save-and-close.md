# Phase 9: Desktop save and close

- Goal: In the desktop app, Export saves a theme file through the native Save dialog, and closing the window or quitting with unsaved Files edits asks first with Save all, Discard and Cancel, with a reviewed design note and tests (amendment A5; R53, R62).
- Round: 2
- Depends on: 6, 7
- Owns: `packages/contracts/src/ipc.ts`, `apps/desktop/src-tauri/src/bridge.rs`, `apps/desktop/src-tauri/src/window.rs`, `apps/desktop/src-tauri/src/lib.rs` (registration only), `apps/web/src/components/settings/AppearanceSettingsPanel.tsx` and its test (the export call only), `apps/web/src/components/files/**` (the close guard only), a new close dialog component under `apps/web/src/components/files/`, `docs/plans/2026-11-10-desktop-save-and-close-design.md`
- Must not touch: `apps/server/**` (Phases 3 to 5), `apps/web/src/index.css`, `apps/web/src/themes/**` except the export call site, `docs/plans/2026-11-09-issue-batch-340-345-290/**`
- Skills: test-driven-development (each behavior starts from a failing test); vercel-react-best-practices (AGENTS.md requires it for changed React components); better-accessibility (the close dialog and its focus order)
- Read first: `spec.md` R53 (desktop export scenario) and R62; `AGENTS.md` (Architectural Decision Standards: privileged desktop operations cross `DesktopBridge` commands and events); `apps/web/src/diagnostics/downloadDiagnosticLogs.ts` lines 155-240 and `apps/web/src/components/files/fileTransfers.ts` lines 10-60 (the existing bridge save patterns); `apps/web/src/components/files/fileEditingSessionRegistry.ts` (settle and the `"failed"` result); `docs/plans/2026-11-09-files-rich-markdown-toolbar-design.md` (delivery contract)
- Checkpoint: `cargo test -p bibcode-desktop -j 2` and, from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/components/files src/components/settings` exit 0. In the desktop app, Export opens the Save dialog, and closing with an unsaved edit shows the three-choice dialog.

Phase 9 compiles desktop Rust, so it runs only when no other lane compiles Rust. It starts from the integrated round 1 branch.

## Tasks

### Task 9.1: Export a theme through the native Save dialog

- Satisfies: R53 (export in the desktop app)
- Depends on: none
- Files: modify `packages/contracts/src/ipc.ts`; modify `apps/desktop/src-tauri/src/bridge.rs`; modify `apps/desktop/src-tauri/src/lib.rs`; modify `apps/web/src/components/settings/AppearanceSettingsPanel.tsx`; test `apps/web/src/components/settings/AppearanceSettingsPanel.test.tsx`; create `docs/plans/2026-11-10-desktop-save-and-close-design.md`
- Interfaces: produces a `DesktopBridge` method `saveTextFile(input: { suggestedName: string; contents: string; mimeType: string }): Promise<string | null>` (the saved path, or `null` when the person cancels; a rejection for a failed write) and its Tauri command. The web export calls it when `window.desktopBridge?.saveTextFile` exists and keeps the blob link in browser mode.
- Skills: none
- Read first: the diagnostics save path named in the phase's Read first line
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-desktop -j 2 save_text_file` and, from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/components/settings/AppearanceSettingsPanel.test.tsx` exit 0 with the new tests passing

Steps

1. [ ] Write the design note: the two new bridge parts (this command and Task 9.2's close event), the alternatives considered (a Tauri download handler, clipboard export, a beforeunload-only guard) and why they lost, the trust boundary (the command writes only to a path the person picked in the native dialog), and the follow-up that `apps/web/src/proposedPlan.ts` can use the same command. Get a read-only Codex review and an advisor review, process both with `receiving-review.md`, list each finding under "Review handling", and set `Status: Approved 2026-11-10 (pre-approved: reviewed by Codex and the advisor)`.
2. [ ] In `AppearanceSettingsPanel.test.tsx`, add `Export in the desktop app saves through the bridge with <id>.theme.json`, `a cancelled save writes nothing and shows no error` and `a failed save shows an error`. Run the Done when web command. Expected: FAIL, the bridge is not called.
3. [ ] Add a Rust unit test `save_text_file_writes_the_contents_to_the_chosen_path` and `save_text_file_returns_none_when_cancelled` with the dialog behind a test seam. Run `cargo test -p bibcode-desktop -j 2 save_text_file`. Expected: FAIL to compile, the command does not exist.
4. [ ] Implement the contract method, the Tauri command (native Save dialog, then a write; a failed write is an error) and the web call.
5. [ ] Run both Done when commands. Expected: PASS.
6. [ ] Prove the tests can fail: make the web export ignore the bridge, run the web command. Expected: FAIL. Restore and run again. Expected: PASS.
7. [ ] Run `vp run check:contracts`, `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings`. Expected: no errors and no fixture diff, or a regenerated fixture committed with the change.

### Task 9.2: Ask before closing with unsaved Files edits

- Satisfies: R62 (save all, a save is blocked, discard and cancel, nothing unsaved)
- Depends on: 9.1
- Files: modify `apps/desktop/src-tauri/src/window.rs`; modify `apps/desktop/src-tauri/src/bridge.rs`; modify `packages/contracts/src/ipc.ts`; modify `apps/web/src/components/files/fileEditingSessionRegistry.ts`; create `apps/web/src/components/files/UnsavedChangesCloseDialog.tsx` and its test; modify the design note
- Interfaces: consumes the registry's sessions and `settle()` with its `"failed"` result; produces a desktop close-request event the web answers (close now, or keep open), a registry method `unsavedSessions(): { path: string }[]` and `saveAll(): Promise<"saved" | "blocked">`, and the dialog with props `{ files: string[]; onSaveAll(): void; onDiscard(): void; onCancel(): void }`. The Close Window menu action and app quit go through the same request. In browser mode the registry adds a `beforeunload` warning while a session is unsaved.
- Skills: better-accessibility (the dialog's focus lands on Save all and Escape cancels)
- Read first: `apps/desktop/src-tauri/src/window.rs` lines 60-90 (the Close Window action calls `window.close()` today)
- Tier: most capable
- TDD: red-green
- Done when: `cargo test -p bibcode-desktop -j 2 close_request` and, from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/components/files` exit 0 with the new tests passing

Steps

1. [ ] Add web tests for each R62 scenario: `closing with a rendered and a source edit and choosing Save all writes both and allows the close`, `Save all with a file changed on disk keeps the window open and shows the reload-or-overwrite choice`, `Discard allows the close without writing`, `Cancel keeps the window open and the edits`, `closing with nothing unsaved closes at once without a dialog`, and `browser mode warns before unload only while an edit is unsaved`. Add Rust tests `close_request_waits_for_the_web_answer` and `close_request_closes_when_the_web_allows_it`. Run both Done when commands. Expected: FAIL.
2. [ ] Implement: the desktop intercepts the window's close request and app quit, asks the web, and closes only on an allow answer (with a timeout that keeps the window open and logs a warning when the web never answers); the web shows the dialog when `unsavedSessions()` is not empty.
3. [ ] Run both Done when commands. Expected: PASS.
4. [ ] Prove the tests can fail: make `saveAll` report `"saved"` without saving, run the web command. Expected: FAIL. Restore and run again. Expected: PASS.
5. [ ] Review the dialog against `vercel-react-best-practices` and `UI.md`, and record both results for the final report.
6. [ ] Run `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `vp run check:contracts` and `vp run check:markdown-links`. Expected: no errors.
