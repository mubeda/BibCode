# Files undo shortcuts, remote branch delete, Antigravity terminal

Status: Approved 2026-11-20 (owner's standing rule: reviewed by Codex and the advisor. Codex's last verdict was "Needs rework"; all its findings were applied and the round 2 fixes were not reviewed again)
Spec: spec.md (Status line: Approved 2026-11-20, sha256 3f5d29373cba)
Repository: this repository
Base: main

## Goal

1. Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z and Ctrl+Y move the Files editor history, in the source and rendered views and in the packaged desktop app (#398).
2. A remote branch row in Git Manager can be deleted after a confirmation, and server block reasons show in the branch dialogs (#397).
3. An enabled Antigravity instance offers an Antigravity Terminal that starts `agy` and an Antigravity chat over `agy acp`, marked Preview (#399).
4. View PR in Source Control opens the PR/MR panel, with a browser entry in the menu (#400).

## Global constraints

- One pull request against `main`; every follow-up found is ticketed and fixed in it (R15, D11).
- Antigravity executable default is `agy`, driver slug `antigravity`, permission flag `--dangerously-skip-permissions`, install probe `agy --version` (R11, R12, D8).
- `--continue` and `--conversation` are never passed on launch (R12).
- "Open in Antigravity" (`packages/contracts/src/editor.ts`, `apps/server/src/production/editor_launch.rs`) is not changed.
- Ctrl+Y redoes on Windows and Linux only (D1).
- Remote delete sends the existing `remote-branch-delete` operation; no new server operation (R6).
- BiBCode never edits the user's Antigravity settings, hooks or MCP files and never reads Google credentials (research report, recommendations).
- Public repository: placeholders only, no real names, hosts, tokens or local paths (AGENTS.md, Sensitive Data).
- Privileged desktop operations cross `DesktopBridge` commands and events only (AGENTS.md, Architectural Decision Standards).
- No unit test may spawn a real provider CLI; `agy` joins the hermetic guard (R14).
- Each `cargo test` invocation takes one filter; `cargo` and packaged builds run one at a time under the executor's shared build lock.

## Review focus

1. The undo chord works in a browser but not in the packaged app, because the native Edit menu handles it differently on each platform. Pinned by Tasks 1.1 and 1.2.
2. A fix for Files undo breaks undo somewhere else (the inline comment textarea, the chat composer). Pinned by Tasks 1.2 and 1.3.
3. Remote Delete enabled on a remote's default branch, or resolved to the wrong remote when one remote's name prefixes another. Pinned by Tasks 2.2 and 2.3.
4. An Antigravity chat that replays a sent prompt after a restart, leaks an account value or provider text into logs or fixtures, or runs without approvals in approval-required mode. Pinned by Tasks 3.6 to 3.8.
5. A settings file written before this change fails to decode, or enables the driver. Pinned by Task 3.2.

## Out of scope

- ACP elicitation forms, MCP servers for the Antigravity chat and in-app sign-in: later issues (spec Non-goals).
- Terminal observer, resume flags, retargeting the editor command to `agy-ide` (spec Non-goals).
- Pull-request detection before a remote delete (D4).
- Deleting the local branch from the remote-delete dialog (D2).

## Sources

- Repository rules: `AGENTS.md` (pre-work, sensitive data, completion requirements, profiler coverage, runbook maintenance); `UI.md` (review of every user-visible change).
- Repository docs: `docs/README.md` (index); `docs/reference/scripts.md` (commands below); `docs/providers/README.md` and `docs/providers/cursor.md` (the terminal-without-observer precedent); `docs/architecture/providers.md` (driver ownership); `docs/user/keybindings.md` and `docs/user/workspace-ui.md` (user guides to update); `docs/testing/README.md` and the three desktop runbooks (packaged UI runs and labs); `docs/skills/issue-delivery/SKILL.md` (checkpoint before costly runs).
- External: issues #397, #398, #399, #400 (the requests, with their code references at 3b7407928).
- External: `research-antigravity.md` in this folder, a research report of 2026-11-20 on the Antigravity CLI, ACP mode, SDKs, terms and host signals, with source links and a list of what is unconfirmed. It holds for CLI 1.5.13. It decides: plain `agy` starts the TUI; no SDK fits; a later chat provider should use `agy acp`; the docs must state Google's position on third-party hosts.
- External: https://antigravity.google/docs/cli/reference/ (flag spellings, re-read in Task 3.1).
- Research: done as the report above. Not run at planning time: nothing was installed, and no `agy` binary exists in CI or the labs.

## Stack and commands

- Web (React, Vite+, Vitest): focused test `cd apps/web && node ../../scripts/run-local-vp.mjs test run --project unit <path>` (from `apps/web/package.json` `test`). Not run at planning time; the suite is long.
- Server and desktop (Rust): `cargo test -p bibcode-server <one filter>`, `cargo test -p bibcode-desktop <one filter>` (from the package `test` scripts; on Windows through `node scripts/run-msvc.mjs`), `cargo fmt --all --check`, `cargo clippy -p bibcode-server -p bibcode-desktop --all-targets -- -D warnings`.
- Contracts: `vp run check:contracts` (regenerates `packages/contracts/fixtures` and fails on an unstaged fixture diff).
- Repository gates: `vp check`, `vp run typecheck`, `vp run check:markdown-links` (which skips `docs/plans/**`).
- Packaged desktop UI: `vp run test:ui:desktop:build`, then `vp run test:ui:desktop`; `BIBCODE_E2E_SPEC=./specs/<file>` runs one spec and `BIBCODE_E2E_PROFILER=1` turns the Profiler on for the run (`apps/desktop/e2e/wdio.conf.ts`, `apps/desktop/e2e/support/test-project.ts`).

## Phases

| Phase | File                                         | Goal                                                             | Round | Depends on | Tier         |
| ----- | -------------------------------------------- | ---------------------------------------------------------------- | ----- | ---------- | ------------ |
| 1     | phases/PHASE-01-files-undo-shortcuts.md      | Undo and redo chords and the Edit menu drive the Files history   | 1     | none       | most capable |
| 2     | phases/PHASE-02-git-manager-remote-delete.md | Remote branch delete in Git Manager, with guard names that agree | 1     | none       | most capable |
| 3     | phases/PHASE-03-antigravity-terminal.md      | Antigravity instance and terminal, terminal-only                 | 1     | none       | most capable |
| 4     | phases/PHASE-04-integration.md               | Review, follow-up fixes, gates on the final commit, pull request | 2     | 1, 2, 3, 5 | standard     |
| 5     | phases/PHASE-05-view-pr-panel.md             | View PR opens the PR/MR panel                                    | 1     | none       | standard     |

Phases in the same round run in parallel. A phase depends only on phases in earlier rounds.

## File map

| Path or external change                                                                                                                                                                                                                                                       | Action                                      | Phase | Verification                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ----- | ----------------------------------------------------------------------- |
| `docs/plans/2026-11-20-undo-remote-delete-antigravity/diagnosis-398.md`                                                                                                                                                                                                       | create                                      | 1     | filled matrix                                                           |
| `apps/desktop/e2e/specs/files-undo-shortcuts.e2e.ts`, `apps/desktop/e2e/wdio.conf.ts`                                                                                                                                                                                         | create, modify                              | 1     | `vp run test:ui:desktop`                                                |
| `apps/web/src/components/files/useFileHistoryInput.ts` and its test                                                                                                                                                                                                           | create (Task 1.2 branch A or B)             | 1     | focused web test                                                        |
| `apps/web/src/components/files/FilePreviewPanel.tsx`                                                                                                                                                                                                                          | modify                                      | 1     | focused web test                                                        |
| `apps/web/src/components/files/fileUndoChords.test.tsx`                                                                                                                                                                                                                       | create                                      | 1     | itself                                                                  |
| `apps/web/src/components/files/FileEditorToolbar.tsx` and its test                                                                                                                                                                                                            | modify                                      | 1     | focused web test                                                        |
| `apps/desktop/src-tauri/src/window.rs`, `apps/web/src/components/AppSidebarLayout.tsx`, `docs/plans/2026-11-20-edit-menu-undo-design.md`, `docs/architecture/overview.md`                                                                                                     | modify or create, only on Task 1.2 branch B | 1     | `cargo test -p bibcode-desktop menu`, review record                     |
| `docs/user/keybindings.md`                                                                                                                                                                                                                                                    | modify                                      | 1     | `vp check`                                                              |
| `apps/web/src/components/gitManager/gitManagerGuardOperations.ts`                                                                                                                                                                                                             | create                                      | 2     | focused web test                                                        |
| `apps/web/src/components/gitManager/dialogs/GitManagerBranchDialogs.tsx`, `toolbar/GitManagerBranchDropdown.tsx`, `GitManagerToolbar.tsx`, `GitManagerPanel.tsx` and their tests                                                                                              | modify                                      | 2     | focused web test                                                        |
| `apps/web/src/components/gitManager/toolbar/remoteBranchRef.ts` and its test                                                                                                                                                                                                  | create                                      | 2     | focused web test                                                        |
| A shared sign-in-aware operation hook under `apps/web/src/components/gitManager/`                                                                                                                                                                                             | create                                      | 2     | focused web test                                                        |
| `apps/server/src/git/manager/refs.rs`, `apps/server/src/git/manager/operations.rs`, `apps/server/src/git/repository.rs`                                                                                                                                                       | modify                                      | 2     | `cargo test -p bibcode-server refs`, `... operations`, `... repository` |
| GitHub issue for the guard-name mismatch                                                                                                                                                                                                                                      | create                                      | 2     | `gh issue view`                                                         |
| `docs/plans/2026-11-20-antigravity-terminal-design.md`                                                                                                                                                                                                                        | create                                      | 3     | review record                                                           |
| `packages/contracts/src/settings.ts`, `packages/contracts/src/model.ts`, `packages/contracts/fixtures/**` (regenerated)                                                                                                                                                       | modify                                      | 3     | `vp run check:contracts`                                                |
| `apps/server/src/server_settings/mod.rs`, `apps/server/src/production/control.rs`                                                                                                                                                                                             | modify                                      | 3     | `cargo test -p bibcode-server server_settings`, `... control`           |
| `apps/server/src/production/provider_inventory.rs`                                                                                                                                                                                                                            | modify                                      | 3     | `cargo test -p bibcode-server provider_inventory`                       |
| `apps/server/src/production/provider_runtime.rs`                                                                                                                                                                                                                              | modify                                      | 3     | `cargo test -p bibcode-server provider_runtime`                         |
| `apps/server/src/hermetic_guard.rs`, `apps/server/tests/support/hermetic_providers.rs`, `apps/server/src/test_support/mod.rs`                                                                                                                                                 | modify                                      | 3     | `cargo test -p bibcode-server hermetic`                                 |
| `apps/web/src/components/chat/providerTerminalActions.ts`, `providerAgentActions.ts`, `providerIconUtils.ts`, `apps/web/src/providerInstances.ts`, `apps/web/src/providerModels.ts`, `apps/web/src/threadProviderBinding.ts`, `apps/web/src/session-logic.ts` and their tests | modify                                      | 3     | focused web test                                                        |
| `apps/web/src/components/settings/providerDriverMeta.ts`, `SettingsPanels.tsx`, `ProviderInstanceCard.tsx`, `apps/web/visual/typography/**`                                                                                                                                   | modify                                      | 3     | focused web test                                                        |
| `docs/providers/antigravity.md`                                                                                                                                                                                                                                               | create                                      | 3     | `vp run check:markdown-links`                                           |
| `docs/providers/README.md`, `docs/architecture/providers.md`, `docs/README.md`                                                                                                                                                                                                | modify                                      | 3     | `vp run check:markdown-links`                                           |
| `apps/web/src/components/SourceControlPanel.tsx`, `GitActionsControl.logic.ts`, `SourceControlPrimaryAction.logic.ts` and their tests                                                                                                                                         | modify                                      | 5     | focused web test                                                        |
| `docs/user/workspace-ui.md`, `docs/testing/**`, `docs/plans/README.md`                                                                                                                                                                                                        | modify                                      | 4     | `vp check`                                                              |
| Follow-up GitHub issues and their fixes                                                                                                                                                                                                                                       | create                                      | 4     | `gh issue list`                                                         |

Shared files reserved for the executor: `progress.md`, lockfiles.
Parallel conflicts: none between round 1 phases, which own disjoint files: phase 1 `apps/web/src/components/files/`, `apps/desktop/`, `AppSidebarLayout.tsx` and `docs/user/keybindings.md`; phase 2 `apps/web/src/components/gitManager/`, `apps/web/src/components/gitSignIn/` and the three Git server files listed; phase 3 `packages/contracts/`, the provider files listed and its docs; phase 5 the three Source Control files, which no other phase edits. Three things are shared and are serialized by the executor's build lock (one lock file in the Git common directory, taken before and released after each such command by the lane that runs it; a workflow coordinator hands out the slot, an inline executor runs them in sequence anyway): every `cargo` build (one target directory per lane worktree, one build at a time), the packaged desktop build (it rewrites `apps/web/dist`), and `vp run check:contracts` (it rewrites the fixtures, which only phase 3 may commit).

## Traceability

| Requirement | Tasks              |
| ----------- | ------------------ |
| R1          | 1.2, 1.3           |
| R2          | 1.2, 1.3           |
| R3          | 1.3                |
| R4          | 1.3                |
| R5          | 1.1, 1.2           |
| R6          | 2.3                |
| R7          | 2.2, 2.3           |
| R8          | 2.3                |
| R9          | 2.1                |
| R10         | 3.1                |
| R11         | 3.2, 3.8, 3.9      |
| R12         | 3.9                |
| R13         | 3.6, 3.7, 3.8, 3.9 |
| R14         | 3.2, 3.10, 4.1     |
| R15         | 2.1, 4.1, 4.2      |
| R16         | 5.1                |

## End-to-end verification

All six run on the commit that is pushed, and its SHA is logged with the results.

1. `vp check` exits 0.
2. `vp run typecheck` exits 0.
3. `cargo fmt --all --check` exits 0, and `cargo clippy -p bibcode-server -p bibcode-desktop --all-targets -- -D warnings` exits 0.
4. `vp run -r --concurrency-limit 1 test` exits 0.
5. `BIBCODE_E2E_PROFILER=1 vp run test:ui:desktop` passes on the packaged build, with `files-undo-shortcuts.e2e.ts` named in the run report; the Profiler data has no new finding.
6. `gh issue list --repo mubeda/BibCode --state open` shows no follow-up of this work without a fix commit.

## Risks

- Issue #398's stated cause is wrong: both editors already bind the chords. The real failure is unlocated -> Task 1.1 reproduces it per platform before any fix, and stops with a question to the reporter if nothing reproduces.
- A menu-level fix (Task 1.2 branch B) changes undo for the whole app -> it needs its own reviewed design note and tests that the composer and plain text fields keep their undo, and it stops with a Ruling if that cannot be kept.
- Windows and Linux native paths need the labs; a locked Mac screen hides the E2E webview -> platforms not measured are named in the report, never assumed.
- The Antigravity driver has many registration sites -> Task 3.1 classifies every hit of one `rg` command, and review finding 8's list is the floor.
- No `agy` binary in CI or the labs -> launch is proven by command construction with fixtures, as #399's acceptance criteria ask; a live TUI start is not claimed.
- Google's terms discourage third-party tools on consumer plans -> BiBCode only runs the user's own unmodified CLI (the TUI, or `agy acp`), the instance is disabled by default, the chat is marked Preview, and the provider guide states the position.
- The research could not confirm every flag spelling from the primary page -> Task 3.1 step 1 re-reads the CLI reference before code depends on them.

## Decisions

- P1. Four parallel phases, one per issue (#400 was added by the owner during planning as phase 5), then one integration phase. Alternatives: one sequential phase (slower, and there is no file conflict to avoid). Decided by: agent's call.
- P2. The client adopts the server's emitted guard names instead of renaming them on the server. Alternatives: rename on the server (changes `blocked_reason_for_operation`, reasons visible over MCP, and eight tests). Decided by: agent's call.
- P3. No web hook for the undo chords is planned up front; the failure is located first. Alternatives: bind a capture-phase hook on the panel (the first draft; the editors already bind the chords, and the hook would have intercepted the comment textarea). Decided by: plan review 1, finding 6.
- P4. Outline and plan approval follow the owner's standing rule that a plan reviewed by Codex and the advisor counts as approved. Alternatives: wait for a chat yes at each gate. Decided by: user (standing rule).
- P5. Skills: every task has an installed skill; no gap, no install.
- P6. Execution continues on the branch this plan was written on, recorded in `progress.md`, not on a new branch cut from `main`. Decided by: agent's call.
- P7. Spec decisions D1, D5, D7 and D9 are the planning agent's calls where the issues left a choice, as are P10 and D12, and D8 follows issue #399's recommendation. The research report advised against a silent permission bypass, but Orca passes the same flag to `agy` by default (research addendum), as BiBCode's other terminals do, so D8 stands; a per-agent permission setting would be a separate issue. The pull request lists all five for the owner.
- P12. Tasks 3.3 to 3.5 were replaced by Tasks 3.6 to 3.10 on 2026-11-20, after the owner ruled that the chat provider is built in this pull request and a live `agy` 1.5.13 handshake on the development machine confirmed the ACP shapes the design relies on. Decided by: user ("Build it now"); task split from the design note's breakdown. Plan review 3 (Codex, Needs rework, 11 findings) was folded into the tasks' rules; its proposal to split Tasks 3.6, 3.7 and 3.9 was taken only as an allowed early commit of the terminal part of 3.9, because one lane runs 3.6 and 3.7 in sequence and each is reviewed at its own commit.
- P9. The Antigravity chat provider uses ACP (`agy acp`), because no SDK fits. Decided by: user, 2026-11-20 ("use ACP if not available"), in line with the research and with Orca.
- P8. The client marks a remote default from each remote's local `HEAD` ref as an early reason only, an ambiguous remote name blocks Delete, and the server decides (P10). Alternatives: a contract change carrying remote and branch separately (larger, touches fixtures phase 3 owns). Decided by: agent's call.
- P10. The server is the authority for every remote branch delete (the new UI, the MCP tool, and local delete with "also delete from its remote"): it names `refs/heads/` explicitly, and one `ls-remote --symref` call before the push refuses the remote's default branch, an unreadable default, and a branch that differs from the local tracking ref. Alternatives: client-side checks only (plan review 2 showed they can target the wrong ref or miss a stale default); refusing any non-standard fetch mapping (it would refuse single-branch clones). This changes the behavior of an existing operation and of the MCP tool, not its contract. Decided by: agent's call, prompted by plan review 2 findings 1 and 3; listed for the owner.
- P11. A workflow lane starts from the plan's branch after the plan folder is committed, and a dependent task's lane starts from its predecessor's commits.

## Appendix: questions record

- 2026-11-20 Evidence: `apps/server/src/git/manager/guards.rs:172-198` emits `checkout`, `delete-branch`, `rename-branch`; the dialogs and dropdown look up `branch-*` names / Decision: R9, Task 2.1.
- 2026-11-20 Evidence: `@pierre/diffs/dist/editor/command.js` binds `cmdOrCtrl+z`, `cmdOrCtrl+shift+z`, `ctrl+y` / Decision: P3; Task 1.1 diagnoses first.
- 2026-11-20 Evidence: `apps/server/src/git/manager/refs.rs:315-346` sets `is_default` for local refs only / Decision: Task 2.2.
- 2026-11-20 Evidence: `GitManagerPanel.tsx:498-523` owns the sign-in offer; the toolbar runner has none / Decision: Task 2.3 shares one hook.
- 2026-11-20 Evidence: `provider_runtime.rs:6975-6985` already rejects an unknown driver with a generic message / Decision: superseded by P12; the driver is dispatched instead.
- 2026-11-20 Evidence: `research-antigravity.md` / Decision: no SDK; terminal now, `agy acp` later; terms stated in the guide (R14).
- 2026-11-20 Q: where, which spec, external sources, reviewer model / Recommended: this folder, the three issues, the issue links, Codex `gpt-6.2-sol` at `high` / Decision: recommended defaults taken without asking, per the owner's autopilot rule.
