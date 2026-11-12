# Phase 8: End-to-end tests, documents and final gates

- Goal: The combined branch is proven in the packaged desktop app, the user guide, runbooks, notices and changelog describe the seven changes, every repository gate passes, and the final report is written.
- Round: 7
- Depends on: 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15
- Owns: `apps/desktop/e2e/specs/files-rich-markdown.e2e.ts`, `apps/desktop/e2e/specs/appearance-themes.e2e.ts`, `apps/desktop/e2e/specs/desktop-save-and-close.e2e.ts`, `apps/desktop/e2e/support/app-lifecycle.ts`, `apps/desktop/e2e/wdio.conf.ts`, `docs/user/workspace-ui.md`, `docs/testing/**`, `apps/web/THIRD_PARTY_NOTICES.md`, `CHANGELOG.md`, and the one selected-state class in `apps/web/src/components/pipelines/detail/PipelineStageColumns.tsx`
- Must not touch: source files of Phases 2 to 7 except to fix a defect an end-to-end test or a gate exposes, which reopens the owning task
- Skills: issue-delivery (acceptance evidence per issue before any costly run)
- Read first: `spec.md` sections Verification and Constraints; `docs/testing/README.md`, `docs/testing/macos-desktop.md` lines 233-259 and `docs/testing/linux-desktop.md` (how the packaged end-to-end suite is built and run on each system); `AGENTS.md` (Testing Runbook Maintenance, Task Completion Requirements, Sensitive Data)
- Checkpoint: `vp check`, `vp run typecheck`, `vp run test`, `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings` and `cargo test -p bibcode-server -j 2` all exit 0, and the three new end-to-end specs pass (`files-rich-markdown`, `appearance-themes` and Phase 9's `desktop-save-and-close`). The user guide, runbooks and changelog also describe the Phase 9 export and close dialog. The branch is ready for a pull request that closes #340, #341, #342, #343, #344, #345 and #290.

Tasks run in this order: 8.4, 8.1, 8.2, 8.3, 8.5. If a later task changes product source, the packaged build and both specs are run again before Task 8.5 closes.

Before the first packaged build, check free disk space with `df -h .`. Expected: at least 60 GB free; with less, stop and report instead of building.

## Tasks

### Task 8.1: Desktop end-to-end test for rich Markdown editing

- Satisfies: R25 (edit a paragraph), R29 (explicit save), R30 (undo a rich edit; switch to source after a rich edit), R31 (untouched file)
- Depends on: 8.4
- Files: create `apps/desktop/e2e/specs/files-rich-markdown.e2e.ts`; modify `apps/desktop/e2e/wdio.conf.ts`
- Interfaces: consumes the local helpers `openFilesSurface` and `openWorkspaceFile` of `apps/desktop/e2e/specs/mermaid-diagrams.e2e.ts` (lines 250 and 281; copy them into the new spec, as specs keep their helpers local, and change the readiness check of `openWorkspaceFile`, which waits for Mermaid-specific headings at line 301, to wait for the text "Hello world" in the rendered view), the default spec list in `wdio.conf.ts` (lines 40-54), and the accessible names "Save file", "Undo", "Redo", "Heading 2" and "Show markdown source" from Phase 6; produces one spec file registered in the default list.
- Skills: none
- Read first: `apps/desktop/e2e/specs/mermaid-diagrams.e2e.ts` and `apps/desktop/e2e/specs/pierre-diffs.e2e.ts` lines 499-515 (the Files open flow and how fixture files are created)
- Tier: standard
- TDD: exempt (an end-to-end check of behavior the unit tests of Phase 6 already pin; it adds no new behavior)
- Done when: `BIBCODE_E2E_SPEC=./specs/files-rich-markdown.e2e.ts vp run test:ui:desktop` exits 0 with 3 passing tests

Steps

1. [ ] Confirm Task 8.4 is Closed, so no source change follows the build, then run `vp run test:ui:desktop:build` on the exact commit that will be reviewed. Expected: exits 0 and the packaged app exists at the path the runbook for this system names. On macOS set `BIBCODE_E2E_PLATFORM`, `BIBCODE_E2E_ARCH` and `BIBCODE_E2E_APP_PATH` as `docs/testing/macos-desktop.md` describes; on Linux prefix the run with `xvfb-run --auto-servernum`.
2. [ ] Write the spec with a fixture `notes.md` (frontmatter, a paragraph "Hello world", a fenced code block) and three tests: `edits in rendered view, saves and keeps the rest of the file` (type " again", apply Heading 2 to the paragraph, press Save file, read the file from disk and assert the frontmatter and fence bytes are unchanged and the paragraph is `## Hello world again`); `undo in rendered view and one-step undo in source view` (Undo removes the heading; make two more edits, switch to source, one Undo removes both); `opening and saving without editing leaves the file byte-identical`.
3. [ ] Add the spec to the default list in `wdio.conf.ts`.
4. [ ] Run `BIBCODE_E2E_SPEC=./specs/files-rich-markdown.e2e.ts vp run test:ui:desktop`. Expected: PASS, 5 tests; then run the two updated specs, expected PASS. A failure that shows a product defect reopens the Phase 6 task that owns it.
5. [ ] Run `vp check` and `vp run typecheck`. Expected: no errors.

### Task 8.2: Desktop end-to-end test for themes

- Satisfies: R37 (Tokyo Night values), R40 (dark theme in Light mode; Undo), R63 (fixture sidebar levels are marked), R41 (switch back to a built-in), R42 (reload with a custom theme), R44 (duplicate a built-in), R47 (edit and cancel)
- Depends on: 8.1
- Files: create `apps/desktop/e2e/specs/appearance-themes.e2e.ts`; modify `apps/desktop/e2e/wdio.conf.ts`; run (lane D6 updated them for the Appearance Mode control) `apps/desktop/e2e/specs/platform-capabilities.e2e.ts` and `apps/desktop/e2e/specs/chat-activity-panel.e2e.ts`
- Interfaces: consumes the packaged build of Task 8.1, the route `/settings/appearance`, the theme row buttons (`data-theme-select`), the Mode group, the Undo action and the accessible names "More actions for <name>", "Duplicate", "Edit", "Save" and "Cancel" from Phase 7 (amendment A8); produces one spec file registered in the default list.
- Skills: none
- Read first: `apps/desktop/e2e/specs/main-window.e2e.ts` (how a spec opens Settings and reloads the window)
- Tier: standard
- TDD: exempt (an end-to-end check of behavior the unit tests of Phase 7 already pin; it adds no new behavior)
- Done when: `BIBCODE_E2E_SPEC=./specs/appearance-themes.e2e.ts vp run test:ui:desktop` exits 0 with 5 passing tests, and the two updated specs pass

Steps

1. [ ] Write the spec with five tests: `the left panel marks its levels` (amendment A9: with the fixture project open, assert an element with `data-sidebar-level="repo"`, one with `data-sidebar-level="checkout"` and `data-primary`, and one with `data-sidebar-level="chat"` exist, in Light and in Tokyo Night); `a dark theme row clicked in Light mode switches to Dark, and Undo restores Light` (amendment A8: set the mode to Light, click the Matrix Dark row, assert the root has `.dark` and the mode is Dark, use Undo, assert Light and the previous dark slot); `Tokyo Night repaints the app and Dark restores it` (set the mode to Dark, click the Tokyo Night row, assert the computed `--background` on the root element is `#1a1b26`; select Dark, assert no inline `--background` remains); `a duplicated theme can be edited with live preview and cancelled` (Duplicate Tokyo Night, Edit, change primary to `#ff0000`, assert the computed `--primary`, Cancel, assert `#7aa2f7`); `a saved custom theme is painted again after a reload` (save a custom dark theme with background `#101820`, reload the window, assert the root background is `#101820`).
2. [ ] Add the spec to the default list in `wdio.conf.ts`.
3. [ ] Run `BIBCODE_E2E_SPEC=./specs/appearance-themes.e2e.ts vp run test:ui:desktop`. Expected: PASS, 5 tests; then run the two updated specs, expected PASS. A failure that shows a product defect reopens the Phase 7 task that owns it.
4. [ ] Take four screenshots through the WebDriver session for the final report, saved outside the repository: the Appearance section in Light and in Tokyo Night, and the Files toolbar with the More menu open in Light and in Dark. Expected: four image files exist; they use fixture data only.
5. [ ] Run `vp check` and `vp run typecheck`. Expected: no errors.

### Task 8.3: User guide, runbooks and notices

- Satisfies: R13 (documentation check)
- Depends on: 8.2
- Files: modify `docs/user/workspace-ui.md`; modify `docs/testing/cross-platform-validation.md`; modify `apps/web/THIRD_PARTY_NOTICES.md`
- Interfaces: consumes the R8 guidance text, the Files editing behavior of Phase 6, the Appearance section of Phase 7, the "Files ported from Orca" and "Packages" sections of `docs/plans/2026-11-09-files-rich-markdown-toolbar-design.md`, and the license section of each built-in in `theme-palettes.md`; produces the help text R13 requires and the notices the spec's Constraints require.
- Skills: none
- Read first: `docs/user/workspace-ui.md` lines 255-270 and 970-990 (the current Git sign-in text; line 988 says remote servers "show the authentication error as before", which is no longer true); `docs/testing/cross-platform-validation.md` (the list of packaged UI flows); `apps/web/THIRD_PARTY_NOTICES.md` (the existing entry format)
- Tier: standard
- TDD: exempt (documentation only, no behavior to test)
- Done when: `rg -c "Push ran on the remote server" docs/user/workspace-ui.md` prints 1 or more, and `vp run check:markdown-links` exits 0

Steps

1. [ ] In `docs/user/workspace-ui.md`, replace the remote-server sentence near line 988 with a short "Pushing from a remote server" paragraph: Git runs on the server; when the push fails for a missing sign-in, BiBCode shows "Push ran on the remote server ..." naming the server; the person uses `git push` in a terminal on that server, in the same repository, as the user that runs BiBCode, then retries. Keep the local Git Credential Manager section as a separate case and do not promise a sign-in window for a plain credential store.
2. [ ] In the same file, add a "Editing Markdown in rendered view" section (the formatting group, link dialog, Insert image copying next to the file, what stays read-only and why, Undo across views) a "Closing with unsaved edits" section (the Save all, Discard and Cancel dialog on close, quit, restart and update install; the browser warning; that ending the OS session cannot wait), the desktop Export note (the native Save dialog for themes and plans), and an "Appearance" section (mode, light and dark slots, the six built-in themes, custom themes, import and export, contrast warnings, that running terminals keep their colors).
3. [ ] In `docs/testing/cross-platform-validation.md`, add the three new end-to-end specs (`files-rich-markdown`, `appearance-themes`, `desktop-save-and-close`) to the packaged UI flows, and describe the changed lifecycle helper (each closing case gets its own app session, and the window is closed while the backend is still up). Review `docs/testing/linux-desktop.md`, `docs/testing/macos-desktop.md` and `docs/testing/windows-desktop.md`; change them only if a command in them changed, otherwise record in the final report that they were reviewed and remain accurate.
4. [ ] In `apps/web/THIRD_PARTY_NOTICES.md`, add entries in the existing format: Orca (MIT, its copyright line, the ported files), each new editor package group with its license, Omarchy (MIT, "Copyright (c) David Heinemeier Hansson") with the Tokyo Night projects (MIT and Apache-2.0) for `tokyo-night.json`, and omarchy-matrix-theme (MIT, "Copyright (c) 2026 Bernard Visagie") for `matrix-dark.json`.
5. [ ] Run `rg -c "Push ran on the remote server" docs/user/workspace-ui.md` and `vp run check:markdown-links`. Expected: a count of 1 or more, and exit 0.

### Task 8.4: Last token switch and changelog

- Satisfies: R50 (a theme sets them)
- Depends on: none
- Files: modify `apps/web/src/components/pipelines/detail/PipelineStageColumns.tsx`; modify `apps/web/src/components/pipelines/detail/PipelinesDetailView.test.tsx`; modify `CHANGELOG.md`
- Interfaces: consumes the utilities `bg-selected` and `text-selected-foreground` (Task 7.3) and the selected job row class near line 38 of `PipelineStageColumns.tsx`; produces no new names.
- Skills: test-driven-development (assert the selected class before switching it)
- Read first: `CHANGELOG.md` (top entry format `## [vX.Y.Z] - YYYY-MM-DD`; add under an "Unreleased" heading if one exists, otherwise create it above the top entry)
- Tier: cheap
- TDD: red-green
- Done when: from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/components/pipelines/detail/PipelinesDetailView.test.tsx` exits 0 with the new test passing

Steps

1. [ ] In `PipelinesDetailView.test.tsx`, add `the selected job row uses the selected token`: select a job and assert its row has `bg-selected` and not `bg-accent`.
2. [ ] Run the command under Done when. Expected: FAIL, the row has `bg-accent`.
3. [ ] Switch the selected-state class near line 38 of `PipelineStageColumns.tsx` to `bg-selected` (and `text-selected-foreground` if it pairs a text class). Leave hover classes as they are. Make the same switch in every file the log line of Task 7.3 lists as excluded with a selected-state class.
4. [ ] Run the same command. Expected: PASS.
5. [ ] Prove the test can fail: put `bg-accent` back, run the same command. Expected: FAIL. Restore and run again. Expected: PASS.
6. [ ] Add seven lines to `CHANGELOG.md`, one per issue, in the file's existing voice, each ending with its issue number, plus one line for the desktop Save dialog on export and the unsaved-edits close dialog (amendment A5) and one for the read-only checkbox history (amendment A6).
7. [ ] Run `vp check`. Expected: no errors.

### Task 8.6: Desktop end-to-end test for export and the close dialog

- Satisfies: R53 (export in the desktop app), R62 (save all, discard and cancel, nothing unsaved)
- Depends on: 8.2
- Files: create `apps/desktop/e2e/specs/desktop-save-and-close.e2e.ts`; modify `apps/desktop/e2e/support/app-lifecycle.ts`; modify `apps/desktop/e2e/wdio.conf.ts`
- Interfaces: consumes `saveTextFile` and its end-to-end seam (Task 9.1), the close request, reply and dialog (Tasks 9.2 and 9.3); produces the spec and a lifecycle change that runs the destructive close cases in their own app session and tolerates an app that has already closed during teardown.
- Skills: none
- Read first: `apps/desktop/e2e/wdio.conf.ts` near line 55 (specs share one session) and `apps/desktop/e2e/support/app-lifecycle.ts` near line 29 (the helper stops the backend before it closes the window); the Phase 9 design note (the export seam)
- Tier: standard
- TDD: exempt (an end-to-end proof of behavior Tasks 9.1 to 9.3 already drove red-green; a second packaged build only to see it fail costs tens of minutes, as decision P3 records)
- Done when: `BIBCODE_E2E_SPEC=./specs/desktop-save-and-close.e2e.ts vp run test:ui:desktop` exits 0 against a packaged build of the integrated branch

Steps

1. [ ] Write the spec: export a custom theme through the real command with the end-to-end seam and assert the written file holds the exported JSON; type an unsaved edit, send a native close request, assert the dialog appears through the real DesktopBridge event, choose Cancel and assert the window, the server and the edit remain; choose Save all and assert the file on disk holds the edit and the app exits; in a fresh session choose Discard and assert the app exits and the file on disk is unchanged; in a fresh session with nothing unsaved choose Quit from the menu and assert the app exits within a few seconds and the server shut down; open the update dialog with an unsaved edit and assert the leave dialog takes focus over it and Cancel returns focus to the update dialog; with nothing unsaved, a close exits at once. Each closing case runs in its own app session.
2. [ ] Change the lifecycle helper so a closing case requests the window close while the backend is still running, teardown accepts an app that has already exited, and a spec that leaves an edit unsaved cannot hang teardown (through `desktop_e2e_prepare_for_exit` or a Discard answer, as the Phase 9 design note chose). Run the Task 8.1 spec after this change too.
3. [ ] Build the packaged app and run the Done when command. Expected: PASS. A failure that comes from Phase 9 code reopens the owning task.
4. [ ] Prove the spec can fail: make the Save all case assert the old file contents, run the Done when command. Expected: FAIL. Restore and run again. Expected: PASS.

### Task 8.5: Final gates, follow-up issue and report

- Satisfies: support (closes the plan: the gates of AGENTS.md and the spec's open question)
- Depends on: 8.3, 8.6, 11.15, 12.12, 13.2
- Files: modify `progress.md` of this plan folder (the executor's own record)
- Interfaces: consumes every earlier task; produces the final report and one new GitHub issue.
- Skills: none
- Read first: `AGENTS.md` (Task Completion Requirements items 1 to 10; Sensitive Data); GitHub issue #290 section "Extension: make the sidebar hierarchy readable" (`gh issue view 290`)
- Tier: standard
- TDD: exempt (a pure command run and a report)
- Done when: `vp check && vp run typecheck && vp run test` exits 0, `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test -p bibcode-server -j 2` exits 0, and `gh issue list --search "sidebar hierarchy in:title" --state open` lists the new issue

Steps

1. [ ] Run `vp check`, `vp run typecheck` and `vp run test`. Expected: each exits 0.
2. [ ] Run `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings` and `cargo test -p bibcode-server -j 2`. Expected: each exits 0.
3. [ ] Run `vp run check:contracts`, `vp run check:dependency-ledger` and `vp run check:markdown-links`. Expected: each exits 0, with no diff under `packages/contracts/fixtures`.
4. [ ] Run `git diff main...HEAD --stat` and `git status --short`, and read the diff for debug output, generated files other than `routeTree.gen.ts` and `pnpm-lock.yaml`, and sensitive data (real hosts, names, machine paths). Expected: none found. Run `vp test run scripts`. Expected: PASS, including the sensitive-data guard.
5. [ ] No follow-up issue is filed for the sidebar hierarchy: amendment A9 brought it into this plan as Phase 10. Create no issue, and do not push or open a pull request unless the user asks.
6. [ ] Write the final report: outcome per issue against its acceptance criteria; the profiler coverage line (child processes: the Git stop policy and lock cleanup of Phase 2; shutdown: the lock-cleanup wait before the profiler teardown; findings: the `worktree.orphan-dir` rule and evidence fields of Phase 5; RPC methods: none added, `is_long_running` unchanged; logs: the lock-removal warning; Phase 9: the close-request warnings when the web never acknowledges or keepalives stop, and the shutdown order that holds quit before the server stops); the review results of Phase 9's dialog; the React best-practices and UI.md review results recorded by Phases 1, 4, 6 and 7; the runbook review result; every Ruling; what was not run and why (the pipeline detail view of #340 is proven by component tests, per spec amendment A2); residual risks; and the exact commands run.
