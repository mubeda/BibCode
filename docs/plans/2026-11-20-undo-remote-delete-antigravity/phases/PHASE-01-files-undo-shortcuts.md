# Phase 1: Files undo and redo shortcuts

- Goal: The undo and redo chords and the desktop Edit menu move the Files editor history one step, in the source and rendered views, on macOS, Windows and Linux, with tests and the keybindings doc updated.
- Round: 1
- Depends on: none
- Owns: `apps/web/src/components/files/**`, `apps/desktop/src-tauri/src/window.rs`, `apps/desktop/e2e/specs/files-undo-shortcuts.e2e.ts`, `apps/desktop/e2e/wdio.conf.ts`, `apps/web/src/components/AppSidebarLayout.tsx` (only on branch B), `docs/user/keybindings.md`, `docs/plans/2026-11-20-undo-remote-delete-antigravity/diagnosis-398.md`
- Must not touch: `apps/web/src/components/gitManager/**`, `apps/web/src/components/chat/**`, `apps/web/src/components/settings/**`, `packages/contracts/**`, `apps/server/**`
- Skills: tdd (a failing test before every behavior change)
- Read first: issue #398 (the report; its cause is marked a guess); `reviews/plan-review-1.md` findings 4 and 6 (the editors already bind the chords, and the native menu differs per platform); `UI.md` (tooltip wording)
- Checkpoint: `BIBCODE_E2E_PROFILER=1 BIBCODE_E2E_SPEC=./specs/files-undo-shortcuts.e2e.ts vp run test:ui:desktop` passes on the packaged build; in the packaged app, a real Cmd+Z or Ctrl+Z after typing in a file removes the typed text.

Facts this phase starts from, checked on 2026-11-20:

- The source editor already binds the chords: `@pierre/diffs/dist/editor/command.js` maps `cmdOrCtrl+z` to undo, `cmdOrCtrl+shift+z` to redo, and `ctrl+y` to redo on Windows and Linux. TipTap's history extension binds its own in the rendered view. A new web hook is therefore not assumed.
- The desktop Edit menu uses predefined Undo and Redo items (`apps/desktop/src-tauri/src/window.rs:116-124`). The pinned menu library handles them differently per platform: responder actions on macOS, injected Ctrl+Z / Ctrl+Y on Windows, and no predefined item on GTK.
- The toolbar picks its history at `FilePreviewPanel.tsx:1125-1126`: `activeRichEditor` when set, otherwise `session`.
- The panel also holds an inline comment textarea (`FilePreviewPanel.tsx:677-689`), which must keep its own native undo.

## Tasks

### Task 1.1: Reproduce the failure and locate it per platform

- Satisfies: R5
- Depends on: none
- Files: create `apps/desktop/e2e/specs/files-undo-shortcuts.e2e.ts`; modify `apps/desktop/e2e/wdio.conf.ts`; create `docs/plans/2026-11-20-undo-remote-delete-antigravity/diagnosis-398.md`
- Interfaces: consumes nothing; produces `diagnosis-398.md`, whose last section gives one disposition per failing cell or group of cells with the same cause (A, B, D, N, U or C, defined in step 5), which Task 1.2 implements
- Skills: mstack-diagnose (reproduce first, one hypothesis at a time); mstack-research (Tauri 2 and its menu library's predefined Undo behavior at the pinned version)
- Read first: `apps/desktop/e2e/specs/files-rich-markdown.e2e.ts` (how a spec opens a file and types); `apps/desktop/e2e/wdio.conf.ts:50-84` (the spec allowlist and `BIBCODE_E2E_SPEC`); `apps/desktop/e2e/support/test-project.ts:1504-1506` (`BIBCODE_E2E_PROFILER`); `docs/testing/macos-desktop.md`, `docs/testing/windows-desktop.md`, `docs/testing/linux-desktop.md` (the packaged runs and labs); `docs/skills/issue-delivery/SKILL.md` (checkpoint before a packaged build)
- Tier: most capable
- TDD: exempt (a diagnosis: it adds a test and a record and changes no product behavior)
- Done when: `diagnosis-398.md` holds the filled matrix of step 4 and a disposition for every failing cell, and `BIBCODE_E2E_SPEC=./specs/files-undo-shortcuts.e2e.ts vp run test:ui:desktop` has been run once with its result recorded; observable in that file

Steps

1. [ ] Write `files-undo-shortcuts.e2e.ts` with one case per view (source on a text file, rendered on a `.md` file) and per direction: seed a fresh marker edit, send the platform chord, assert the text and the toolbar's Undo and Redo enabled states. Add a case that Ctrl/Cmd+S still saves, and one that undo in the chat composer still works. Add the spec to the allowlist in `wdio.conf.ts`.
2. [ ] Check `df -h` and `uptime`, take the shared build lock, and build once with `vp run test:ui:desktop:build`. Expected: the packaged app is produced.
3. [ ] Run `BIBCODE_E2E_PROFILER=1 BIBCODE_E2E_SPEC=./specs/files-undo-shortcuts.e2e.ts vp run test:ui:desktop`. Expected: PASS or FAIL, recorded as is. A pass here proves only the injected-key path, because the driver may deliver keys inside the webview.
4. [ ] Fill the matrix in `diagnosis-398.md`, each cell from a freshly seeded edit: platform (macOS, Windows, Linux) by view (source, rendered) by direction (undo, redo) by path (real OS keystroke, Edit menu item, driver key). On macOS send the real keystroke and click the menu item through System Events (`osascript`); on Windows and Linux use the labs the runbooks name. For each failing cell record what reached the editing host: a `keydown`, a cancellable `beforeinput` with `inputType` `historyUndo` or `historyRedo`, or nothing (temporary logging, removed before the task ends).
5. [ ] Give every failing cell, or group of cells with the same cause, one disposition, and write them as the file's last section:
   - C: the cell passes.
   - N: the menu item does not exist on that platform (the pinned menu library adds no predefined Undo or Redo on GTK). Recorded; not a failure of the menu path.
   - A: a cancellable `beforeinput` history event reaches the editing host. Fix: handle that event on the editing host.
   - B: nothing reaches the webview, or the event that arrives cannot be cancelled. Fix: custom menu items over the existing `DesktopBridge.onMenuAction` channel, after a reviewed design note.
   - D: a `keydown` reaches the editing host but the history does not move. An editor-host defect, fixed in the web code.
   - U: the platform or path could not be measured. File a follow-up issue naming the lab that was unavailable and record its number.
     Whatever the result, post the matrix as a comment on issue #398. If every measured cell is C or N, also ask the reporter there for the platform and view; Task 1.2 then closes without a code change.
6. [ ] Run `vp check`. Expected: no errors in the files this task created.

### Task 1.2: Fix the located path and prove it in the packaged app

- Satisfies: R1, R2, R5
- Depends on: 1.1
- Files: modify `apps/web/src/components/files/FilePreviewPanel.tsx`; create `apps/web/src/components/files/useFileHistoryInput.ts` and `apps/web/src/components/files/useFileHistoryInput.test.tsx` (branch A or B); modify `apps/desktop/src-tauri/src/window.rs` and `apps/web/src/components/AppSidebarLayout.tsx` (branch B only); modify `apps/desktop/e2e/specs/files-undo-shortcuts.e2e.ts`; modify `docs/plans/2026-11-20-undo-remote-delete-antigravity/diagnosis-398.md`
- Interfaces: consumes `diagnosis-398.md`; `FileEditingSession.undo(): void` / `.redo(): void` (`fileEditingSession.ts:417-427`); `RichMarkdownEditor.undo()` / `.redo()` (`richMarkdownExtensions.ts:44-48`); on branch B `DesktopBridge.onMenuAction(listener: (action: string) => void): () => void` (`packages/contracts/src/ipc.ts:1394`). Produces `useFileHistoryInput(hostRef: RefObject<HTMLElement | null>, history: { undo(): void; redo(): void } | null): void`
- Skills: rust-best-practices (menu wiring on branch B); vercel-react-best-practices (effect and ref rules for the hook); mstack-diagnose (when a fix does not turn its cell green)
- Read first: `docs/plans/2026-11-20-undo-remote-delete-antigravity/diagnosis-398.md` (binding for this task); `apps/web/src/components/files/FilePreviewPanel.tsx:446-470,746-754,892-914,1122-1126`; `apps/web/src/components/files/RichMarkdownView.tsx:47-54`; `apps/web/src/components/AppSidebarLayout.tsx:140` (how menu actions are consumed today)
- Tier: most capable
- TDD: red-green
- Done when: `BIBCODE_E2E_PROFILER=1 BIBCODE_E2E_SPEC=./specs/files-undo-shortcuts.e2e.ts vp run test:ui:desktop` exits 0, and every cell of the `diagnosis-398.md` matrix on a platform whose code changed is re-measured green by its native path and recorded in that file; when every cell was C or N, the recorded matrix and the passing spec close the task with no code change

Rules for this task

- Work each disposition of `diagnosis-398.md` on its own: A and D are web fixes with a failing web test first; B is the menu fix. A platform can need more than one.
- For B, the design note comes first, before any code: write `docs/plans/2026-11-20-edit-menu-undo-design.md`, get a Codex and an advisor review, and record them in it. The note gives the exact routing of the menu action for a focused Files editing host, the inline comment textarea, the chat composer (its own Lexical history), a terminal, and a plain input, and names any file outside this phase's ownership that must change, which is handed to the executor.
- After any change to a menu item or accelerator, re-measure every cell of that platform, the passing ones included, and the outside-Files cases (composer, comment textarea, terminal).
- If every cell is C or N, do steps 7 and 8 only.

Steps

1. [ ] Write the failing test for the branch chosen. Branch A: in `useFileHistoryInput.test.tsx`, a cancellable `beforeinput` with `inputType` `historyUndo` dispatched on the editing host calls `history.undo` once and is default-prevented; `historyRedo` calls `redo`; the same event on the inline comment textarea or outside the host calls nothing; a `null` history attaches nothing. Branch B: a Rust test in `window.rs` that the Edit menu's Undo and Redo items carry the menu action ids `edit-undo` and `edit-redo` with the platform accelerators, and a web test that the `edit-undo` action calls the Files history once when focus is inside a Files editing host, and otherwise leaves the focused element's own undo untouched (assert it with a real textarea and with the composer's editor).
2. [ ] Run the focused test: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/files/useFileHistoryInput.test.tsx`, and on branch B also `cargo test -p bibcode-desktop menu`. Expected: FAIL, because the handler or the menu ids do not exist.
3. [ ] Implement the branch. In both, the history is one memoized object built from the exact expressions the toolbar uses at `FilePreviewPanel.tsx:1125-1126`, shared with the toolbar rather than copied, and the handler is scoped to the editing host found through the event's composed path, so the comment textarea is never intercepted. Branch B on a platform where focus is outside Files must fall through to the platform's own undo for that element; if the composer's undo cannot be preserved, stop and log a Ruling instead of shipping.
4. [ ] Disposition B only: confirm the reviewed design note of the Rules above exists before this step's code is written, and update the `DesktopBridge` part of `docs/architecture/overview.md` in the same change. No new bridge command or event is added; the existing string-valued menu action carries the two ids.
5. [ ] Run the focused tests. Expected: PASS.
6. [ ] Prove the test can fail: make the handler return before calling the history, run the focused web command. Expected: FAIL. Restore and run again. Expected: PASS.
7. [ ] Take the build lock, rebuild, and run the Done when command. Expected: PASS, all cases. Then re-measure every previously failing matrix cell by its native path on its platform and record the result in `diagnosis-398.md`.
8. [ ] Run `cargo fmt --all --check` and `cargo clippy -p bibcode-desktop --all-targets -- -D warnings` if `window.rs` changed, and `vp check`. Expected: no errors. A platform that could not be measured is named in the task report with the reason.

### Task 1.3: Pin the chord behavior in web tests and correct the tooltip

- Satisfies: R1, R2, R3, R4
- Depends on: 1.2
- Files: create `apps/web/src/components/files/fileUndoChords.test.tsx`; modify `apps/web/src/components/files/FileEditorToolbar.tsx`; test `apps/web/src/components/files/FileEditorToolbar.test.tsx`; modify `docs/user/keybindings.md`
- Interfaces: consumes `FilePreviewPanel` and the real Pierre and TipTap editors; produces `redoShortcutLabel(isMac: boolean): string` in `FileEditorToolbar.tsx`
- Skills: vercel-react-best-practices (required review for the changed toolbar); mstack-diagnose (when a baseline test fails in the browser path)
- Read first: `apps/web/src/components/files/FileEditorToolbar.tsx:152-185`; `apps/web/src/components/files/FilePreviewPanel.test.tsx` (how the panel is mounted in tests); `docs/user/keybindings.md`
- Tier: standard
- TDD: red-green
- Done when: `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/files/fileUndoChords.test.tsx src/components/files/FileEditorToolbar.test.tsx` exits 0

Steps

1. [ ] Write `fileUndoChords.test.tsx` against the mounted panel with the real editors: in the source view, after one typed edit, the undo chord restores the text and the toolbar shows Undo disabled and Redo enabled, the redo chord restores the edit, and a chord with nothing to undo changes nothing and is default-prevented; in the rendered view, two edits that land in two history steps (separate them past the history grouping delay with fake timers, and assert as a precondition that two `undo()` calls are needed) lose exactly one step per undo chord, and a formatting edit is undone and redone; Ctrl+Y redoes in both views when the platform is Windows or Linux and does nothing on macOS; a chord typed in the inline comment textarea does not move the file's history; Ctrl/Cmd+S still saves.
2. [ ] Write the failing tooltip test in `FileEditorToolbar.test.tsx`: `redoShortcutLabel(false)` names Shift+Ctrl+Z and Ctrl+Y, `redoShortcutLabel(true)` names Shift+Cmd+Z and does not name Ctrl+Y (it may name other chords that work in both views), and the Redo button's tooltip uses it.
3. [ ] Run the Done when command. Expected: FAIL in the tooltip test. A baseline case of step 1 that fails is a real browser-path defect: reproduce it with `mstack-diagnose`, fix it in the editing host with a test that stays, and log a Ruling in `progress.md`. A baseline case that passes stays as a regression test; that is its purpose.
4. [ ] Implement `redoShortcutLabel` with the platform helper the web app already uses (find it with `rg -n "isMacPlatform|isMac\b" apps/web/src`), and document the three chords in `docs/user/keybindings.md` under the Files editor.
5. [ ] Run the Done when command. Expected: PASS.
6. [ ] Prove the tests can fail: make `redoShortcutLabel` ignore its argument, run the Done when command. Expected: FAIL. Restore and run again. Expected: PASS.
7. [ ] Run `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit src/components/files` and `vp check`. Expected: PASS and no errors. Review the toolbar change against `vercel-react-best-practices` and the tooltip against `UI.md`; record both in the task report.
