# Spec: Files undo shortcuts, remote branch delete, Antigravity terminal

Status: Approved 2026-11-20 (issues #397 to #400 are the owner's requests; open questions take each issue's recommended answer, recorded under Decisions)
Source: https://github.com/mubeda/BibCode/issues/397, https://github.com/mubeda/BibCode/issues/398, https://github.com/mubeda/BibCode/issues/399, https://github.com/mubeda/BibCode/issues/400, verified at `origin/main` 3b7407928. Triage: `triage.md`.

## Goals

1. Undo and redo work from the keyboard in the Files editor (#398).
2. A remote branch can be deleted from the Git Manager branch list (#397).
3. The AI Terminal menu can start the Antigravity CLI (`agy`) (#399).
4. View PR opens BiBCode's PR/MR panel (#400).

## Requirements

### R1. Source-view undo and redo chords

- GIVEN the Files source editor has focus and one typed edit, WHEN the user presses Ctrl+Z (Windows, Linux) or Cmd+Z (macOS), THEN the edit is undone through the same history as the Undo button, exactly one step, and `canUndo` / `canRedo` on the toolbar stay in sync.
- GIVEN an undone edit, WHEN the user presses Shift+Ctrl+Z or Shift+Cmd+Z, THEN it is redone, exactly one step.
- GIVEN nothing to undo, WHEN the chord is pressed, THEN nothing changes and the event is still default-prevented.

### R2. Rendered-Markdown undo and redo chords

- GIVEN the rendered Markdown editor has focus and one text or formatting edit, WHEN the undo chord is pressed, THEN exactly one history step is undone (never two), and the redo chord restores it.

### R3. Ctrl+Y redo

- GIVEN Windows or Linux, WHEN Ctrl+Y is pressed in either Files editor view, THEN one step is redone.
- GIVEN macOS, WHEN Ctrl+Y is pressed, THEN the Files shortcut does nothing (D1).
- The Redo tooltip names every chord that works on the current platform.

### R4. Scope of the chords

- GIVEN focus outside the Files editor surface (chat composer, terminal, other panels), WHEN the chords are pressed, THEN behavior is unchanged from before.
- Ctrl/Cmd+S still saves.

### R5. Desktop Edit menu

- GIVEN the packaged desktop app with focus in a Files editor view, WHEN the user presses the chord or chooses Edit > Undo / Redo, THEN the Files editor history moves one step, or the plan records, with evidence from a packaged run, why the menu path is equivalent to the chord path.

### R6. Delete a remote branch

- GIVEN a remote branch row in the Git Manager branch list, WHEN the user chooses Delete and confirms in a dialog with the same required confirmation as local delete, THEN the client sends `remote-branch-delete` with that row's remote and branch name.
- GIVEN a local branch of the same name, THEN it is unchanged (D2).
- GIVEN a remote-only branch, THEN it can be deleted the same way.
- GIVEN a successful delete, THEN refs refresh and the row disappears.

### R7. Remote default branch is blocked

- GIVEN the remote row is known to be the remote's default branch, WHEN the user looks at its Delete action, THEN it is disabled with a visible reason, and no request can be sent (D3).
- GIVEN any remote delete request, THEN the server refuses to delete the remote's default branch, and refuses when it cannot check which branch that is. A symbolic `HEAD` row is never listed.
- The delete names the branch ref explicitly, so a tag of the same name is never deleted, and it is refused when the branch on the remote differs from what this checkout last fetched.

### R8. Remote delete failures are visible

- GIVEN missing credentials, THEN the existing sign-in path of #325 runs; GIVEN the remote refuses the push (for example a protected branch), THEN the dialog shows the Git error and stays open. The dialog text says the remote may refuse protected branches. No pull-request detection (D4).

### R9. Guard names agree between server and client

- GIVEN the server blocks deleting or renaming a local branch (current branch, default branch, held by a worktree), WHEN the Delete or Rename dialog opens, THEN it shows the server's reason. Today the server emits `delete-branch` / `rename-branch` and the dialogs look up `branch-delete` / `branch-rename`, so the reason never shows.
- `remote-branch-delete` stays allowed while a merge, rebase, cherry-pick, revert or squash is in progress (D5).

### R10. Antigravity design note

- A design note in `docs/plans/` settles: the driver slug, how a terminal-only instance appears in Settings, the permission flag, the model and effort source, every registration site, the chat provider over ACP, and the editor-catalog overlap. Review by Codex and the advisor counts as its approval (D6).

### R11. Antigravity provider instance

- GIVEN Settings > Agents, THEN an Antigravity instance can be added or enabled, with the existing Antigravity icon and a binary path that defaults to `agy` (never the driver slug). New installs have it disabled (D7).
- GIVEN an enabled instance, THEN the server probes it with `agy --version`; sign-in stays the CLI's own. No terminal observer.

### R12. Antigravity Terminal launch

- GIVEN an enabled instance and `agy` installed, WHEN the user picks Antigravity Terminal in the AI Terminal menu, THEN the TUI starts in the thread checkout as `<binary> --dangerously-skip-permissions`, plus `--model <m>` and `--effort <e>` only when session defaults supply them, with `activity: { driverKind, providerInstanceId }` (D8).
- A configured binary path overrides `agy`. `--continue` and `--conversation` are never passed.

### R13. Antigravity chat over ACP

- GIVEN an enabled Antigravity instance with `agy` 1.5.4 or later, WHEN the user starts an Antigravity chat, THEN the server spawns `<binary> acp` in the thread checkout, speaks ACP v1 over stdio, and the chat streams replies, tool activity and approval requests like the other chat providers (D9).
- GIVEN an older `agy` or a peer that answers another protocol version, THEN the chat start fails with a message that names the required version, and the terminal stays available.
- GIVEN the CLI is not signed in (error `-32000`, "Authentication required"), THEN the thread shows how to sign in (`agy`, or `agy acp --login`); BiBCode never signs the user in and never reads Google credentials.
- GIVEN a thread with a saved session, WHEN the server restarts, THEN the driver reopens it with `session/resume`, else `session/load`, else a new session, and never replays an already sent prompt.
- GIVEN approval-required mode, THEN the session runs in the advertised `default` mode and tool requests reach the user; when `default` is not advertised the chat start is refused. Full access and plan mode follow the design note.
- The models and thinking levels offered come from the session's advertised options, never from a hard-coded list.
- The Settings card marks the chat as Preview. "Open in Antigravity" (`agy --goto`) is unchanged.

### R14. Antigravity cannot be spawned by unit tests, and is documented

- `agy` is in the hermetic guard list.
- `docs/providers/antigravity.md` covers install (`agy --version`), sign-in (`agy`, or `agy acp --login` without a browser), the permission flag, the `agy` CLI versus IDE launcher PATH clash, and Google's stated position on third-party hosts for consumer plans; the provider index and AI Terminal notes link it. It also covers the chat (version, sign-in, modes, known limits).
- Every living document that lists the supported providers names Antigravity: `README.md`, `docs/README.md`, `docs/getting-started/provider-setup.md`, `docs/architecture/providers.md` and `overview.md`, `docs/user/workspace-ui.md`, `docs/reference/encyclopedia.md`, the `docs/testing` runbooks that state provider visibility, and `CHANGELOG.md`.

### R15. Follow-ups and gates

- Every follow-up found while delivering R1 to R14 gets a GitHub issue and is fixed in the same pull request.
- `vp check`, `vp run typecheck`, `cargo fmt --all --check`, Clippy with warnings denied on changed targets, and focused tests pass. Changed React is reviewed against `vercel-react-best-practices`, changed UI against `UI.md`. Affected testing runbooks are reviewed. The report has a profiler coverage line. No credentials, real names, private hosts or local paths in commits, the PR or the docs.

### R16. View PR opens the PR panel

- GIVEN an open pull request and a panel that can open, WHEN the user clicks View PR (View MR on GitLab) in Source Control, THEN the PR/MR panel opens on that pull request and the browser does not.
- The menu offers "Open PR in browser", which opens the PR URL in the browser.
- GIVEN the panel cannot open, THEN View PR opens the browser, as before (D12).

## Non-goals

- A chat-panel driver for Antigravity (`agy acp`): a later issue.
- A terminal observer, resume flags, or retargeting "Open in Antigravity" to `agy-ide`.
- Pull-request detection before a remote delete.
- Deleting the local branch from the remote-delete dialog.

## Decisions

- D1. Ctrl+Y redoes on Windows and Linux only; on macOS Ctrl+Y is a text-system key. Source: #398 question 2 recommends Windows; adding Linux and excluding macOS is the planning agent's call, listed for the owner.
- D2. Remote delete leaves the local branch alone. Source: #397 question 1, recommended.
- D3. The remote default branch is blocked in the UI. Source: #397 question 2, recommended.
- D4. No pull-request detection in v1. Source: #397 question 3, recommended.
- D5. `remote-branch-delete` is not added to the operations blocked during an in-progress operation: `git push <remote> :<branch>` touches neither the index nor the working tree. Source: #397 question 4 leaves it open; the planning agent's call, listed for the owner.
- D6. The design note is required and is approved by Codex and advisor review. Source: #399 question 1, recommended yes; the owner's standing rule that reviewed designs count as approved.
- D7. A new Antigravity instance is disabled by default. Source: #399 proposed behavior offers this or enabled-but-unready; the planning agent's call, listed for the owner.
- D8. The permission flag is `--dangerously-skip-permissions`. Source: #399 question 2, recommended.
- D9. The Antigravity chat provider is built in this pull request over ACP (`agy acp`), with no SDK, and ships as Preview on an instance that is disabled by default. Source: the owner, 2026-11-20 ("use ACP if not available", "Build it now"); this reverses the first draft, which offered no chat.
- D10. Edit menu Undo and Redo drive the Files history when that surface has focus. Source: #398 question 3, recommended yes.
- D11. One pull request, base `main`.
- D12. View PR falls back to the browser where no panel can host the pull request. Source: issue #400, the planning agent's call, listed for the owner.

## Verification

1. Focused web tests for the Files chords, the Git Manager dialogs and dropdown, and the provider actions pass.
2. Focused server tests for guards, the provider inventory and the hermetic guard pass.
3. The packaged desktop UI suite passes with the Profiler on, including the new Files undo spec, and its Profiler data shows no new finding.
4. The gates in R15 pass.
