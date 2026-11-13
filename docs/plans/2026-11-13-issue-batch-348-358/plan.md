# Issue batch #348 and #351 to #358: terminal panel, Git, worktree, update guard and web follow-ups

Status: Approved 2026-11-13 (the user's standing pre-approval of 2026-10-30, after two Codex reviews and the advisor's; see reviews/)
Spec: spec.md (Status line: Approved 2026-11-13, sha256 cd8779b5f2cb)
Repository: this repository
Base: main

## Goal

1. A terminal repaints with the right glyph metrics after a late font load or a late creation, counts widths the way current programs do, and keeps a content-free size record in development.
2. Expanding a reasoning row that the reader brought into view leaves the chat where it was, on Windows too.
3. Every item of #352 to #358 is fixed with a failing-first test, decided by a recorded test or probe, or recorded as a limit in code or docs.

#350 (the server-side terminal screen) is not in this plan. It was closed as not planned on 2026-11-13; its design and evidence are in `../2026-11-13-terminal-screen-350/` (spec D2).

## Global constraints

- xterm.js stays at 6.0.0; the only new dependency is `@xterm/addon-unicode11` 0.9.0 (spec Non-goals, R5).
- Failure backoff for a lookup: 5 seconds. Remembered pull request: cleared by a failed lookup when the last success is more than 5 minutes old (D6, D7).
- `pull` stays out of `takes_index_lock` (D5). Tooltips take no occlusion lease (D11).
- A creation record is reaped only when its folder is missing and the folder's parent directory exists (D9).
- New capability name: `terminalSizeHandOver`, decoding default `false` (R41). New quiesce step name: `pull-request-lookups` (R26). New removal mode: `create-rollback` (R32).
- Size record: last 200 records, no terminal content (R4).
- No test may depend on a wall-clock bound that load can exceed (Goal 5).
- Placeholders only in tests, fixtures, docs, commits and the pull request: `gitlab.example.test`, `example-group/sample-project`, `Test User` (D14, AGENTS.md Sensitive Data).
- Rust toolchain 1.98.1 first on `PATH`; Rust writers set `CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=line-tables-only CARGO_BUILD_JOBS=3`; at most 4 Rust writers at once and at least 60 GB of free disk before a round starts.

## Review focus

1. A mirror window must never reflow at its own size when it repaints after a font load. Pinned by Task 1.1 (a fit mock that really resizes).
2. Shutdown order: lookups end before `git-writes` and the profiler teardown, and a lookup admitted after shutdown cannot panic or hang. Pinned by Task 2.4.
3. A cancelled lookup must not be remembered as a failure, or a leaving caller poisons the key for 5 seconds. Pinned by Task 2.5.
4. A failed desktop state query must never release the unsaved-edits block, and the block must survive a reload and a relaunched web process. Pinned by Task 4.2 and Task 8.1.
5. A popup kept mounted while closed must hold no occlusion lease, and a popup that moves without resizing must update its lease. Pinned by Task 6.2.

## Out of scope

- The server-side terminal screen of #350: own folder, design in rework (D2).
- Replacing or upgrading xterm.js: no evidence it fixes these items.
- A CI lane for a new client against an older server binary: Task 8.2 runs the check once.
- Git sign-in from the client, new update-install UI beyond the dialog's exit, a creation-record schema change (D10).
- Speculative fixes for lab observations whose bounded probe gives no signal (R20, R43, R44).

## Sources

- Repository rules: `AGENTS.md` (pre-work, completion gates, profiler coverage, sensitive data, runbook maintenance); `UI.md` (review of every user-visible change).
- Repository docs: `docs/README.md` (docs index); `docs/architecture/overview.md` (terminal, Profiler, worktree and Source Control sections); `docs/reference/workspace-layout.md` and `docs/reference/scripts.md` (where code and scripts live, real commands); `docs/testing/*.md` (lab procedures); `docs/skills/bibcode-profiler/references/events.md` (events to extend); `docs/plans/2026-11-09-issue-batch-340-345-290/` (the batch these issues follow up; its spec's R16 is the index-lock ownership rule).
- Issues: `sources/issue-*.md` (exported 2026-11-13); `evidence.md`; `triage.md`.
- External: none.

## Stack and commands

- Server and desktop host: Rust 1.98.1 (Axum, Tokio, Tauri 2). `cargo test -p bibcode-server --lib <filter>`, `cargo test -p bibcode-server --test <name>`, `cargo test -p bibcode-desktop`, `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`.
- Web: React with Vite+. From `apps/web`: `vp test run --project unit <paths>` (DOM tests through their `*.dom.test.tsx` companion). Repository root: `vp check`, `vp run typecheck`, `vp run test`, `vp run check:contracts`, `vp run check:markdown-links`, `vp test run scripts`.
- Packaged desktop e2e (WebdriverIO): `vp run test:ui:desktop:build`, then `vp run test:ui:desktop`.
- Checked on 2026-11-13: `vp install` ran clean on the base commit. The test commands were taken from `package.json`, `.github/workflows/ci.yml` and the testing runbooks and were not run during planning (the first server test build takes about ten minutes); each phase's first test step runs them.

## Phases

| Phase | File                                                  | Goal                                                                                                                                                           | Round | Depends on             | Tier         |
| ----- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------- | ------------ |
| 1     | phases/PHASE-01-terminal-panel-fixes.md               | Terminal panel: late font and late creation repaint, size record, Fit feedback, hand-over capability, WebGL retry, Unicode 11 widths, two decide-by-test items | 1     | none                   | most capable |
| 2     | phases/PHASE-02-git-and-pull-request-lookups.md       | Git lock limits, sign-in detector, lookup teardown, backoff and expiry                                                                                         | 1     | none                   | most capable |
| 3     | phases/PHASE-03-worktree-records-and-removal-test.md  | Creation records by id, audited rollbacks, unmounted-volume gate, deterministic drain test                                                                     | 1     | none                   | most capable |
| 4     | phases/PHASE-04-update-install-guard.md               | Update install guard across reload, lost event and late sources; event-name guard                                                                              | 1     | none                   | standard     |
| 5     | phases/PHASE-05-reasoning-row-scroll-and-dashboard.md | Reasoning row keeps its place; Host dashboard values view stops re-rendering                                                                                   | 1     | none                   | most capable |
| 6     | phases/PHASE-06-popups-picker-and-markdown-images.md  | Popup occlusion by rectangle, model picker reopen, read-only Markdown images                                                                                   | 1     | none                   | standard     |
| 7     | phases/PHASE-07-server-odds-and-e2e-harness.md        | AppImage mounts hidden, per-test webview probe, flaky hint test, pairing refusal logs                                                                          | 1     | none                   | standard     |
| 8     | phases/PHASE-08-labs-and-probes.md                    | Linux lab, Windows VM, mixed-version probe and load runs, with the Profiler on                                                                                 | 2     | 1, 2, 3, 4, 5, 6, 7    | most capable |
| 9     | phases/PHASE-09-docs-gates-and-pull-request.md        | Living docs, final gates, reviews and the pull request                                                                                                         | 3     | 1, 2, 3, 4, 5, 6, 7, 8 | most capable |

Phases in the same round run in parallel. A phase depends only on phases in earlier rounds.

## File map

| Path or external change                                                                                                                                                                                                                    | Action   | Phase | Verification                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ----- | ------------------------------------------------------------------------------------------------------ |
| `apps/web/src/components/ThreadTerminalPanel.tsx` and `ThreadTerminalPanel.interactions.test.tsx`                                                                                                                                          | modify   | 1     | from `apps/web`: `vp test run --project unit src/components/ThreadTerminalPanel.interactions.test.tsx` |
| `apps/web/src/components/terminalSizeDiagnostics.ts` and its test                                                                                                                                                                          | create   | 1     | same command with the new test path                                                                    |
| `apps/web/src/components/terminalSizing.ts` (re-measure helper) and a new `terminalSizing.xterm.test.ts`; `terminalSizePolicy.ts`, `apps/web/src/lib/terminalFont.ts` (only if a task needs it)                                            | modify   | 1     | their existing tests                                                                                   |
| `apps/web/package.json` (dependency `@xterm/addon-unicode11` 0.9.0)                                                                                                                                                                        | modify   | 1     | `vp install`, then the R5 xterm test                                                                   |
| `packages/contracts/src/environment.ts`, `packages/contracts/fixtures/**`, `packages/shared/src/testSupport.ts`                                                                                                                            | modify   | 1     | `vp run check:contracts`                                                                               |
| `apps/server/src/lifecycle.rs`, `apps/server/src/production/control.rs`                                                                                                                                                                    | modify   | 1     | `cargo test -p bibcode-server --lib lifecycle`                                                         |
| `apps/server/src/git/process.rs`, `apps/server/src/git/sign_in.rs`                                                                                                                                                                         | modify   | 2     | `cargo test -p bibcode-server --lib -- sign_in:: index_lock_cleanup_`                                  |
| `apps/server/src/source_control/open_pull_request_lookups.rs`, `apps/server/src/source_control/pull_request.rs`                                                                                                                            | modify   | 2     | `cargo test -p bibcode-server --lib open_pull_request_lookups::`                                       |
| `apps/server/src/git/broadcaster.rs`, `apps/server/src/production/git_vcs.rs`, `apps/server/src/production/runtime.rs`                                                                                                                     | modify   | 2     | Phase 2 checkpoint                                                                                     |
| `apps/server/src/production/worktree_catalog_rpc.rs`, `apps/server/src/diagnostics/profiler/worktree_audit.rs`                                                                                                                             | modify   | 3     | `cargo test -p bibcode-server --lib worktree`                                                          |
| `apps/server/src/persistence/repositories.rs`, `apps/server/tests/repositories.rs`, `apps/server/src/production/orchestration_effects.rs`, `apps/server/tests/profiler_worktree_audit.rs`, `apps/server/src/mcp/tools/worktrees.rs`        | modify   | 3     | `cargo test -p bibcode-server --test repositories` and `--test profiler_worktree_audit`                |
| `apps/web/src/components/files/unsavedFileEdits.ts`, `UnsavedChangesCloseDialog.tsx` and their tests; `apps/web/src/tauriDesktopBridge.ts` (the `getUpdateState` entry) and its test                                                       | modify   | 4     | Phase 4 checkpoint                                                                                     |
| `scripts/desktop-event-names.test.ts`                                                                                                                                                                                                      | create   | 4     | `vp test run scripts/desktop-event-names.test.ts`                                                      |
| `apps/web/src/components/ChatView.tsx` and `ChatView.test.tsx`; `apps/web/src/components/chat/timelineScrollAnchoring.ts`, `MessagesTimeline.logic.ts`, `MessagesTimeline.tsx` and their tests                                             | modify   | 5     | Phase 5 checkpoint                                                                                     |
| `apps/web/src/components/hostDashboard/HostDashboardSheet.tsx` and its test                                                                                                                                                                | modify   | 5     | Phase 5 checkpoint                                                                                     |
| `apps/web/src/browser/browserSurfaceStore.ts`, `browserSurfaceSync.ts` and their tests                                                                                                                                                     | modify   | 6     | from `apps/web`: `vp test run --project unit src/browser`                                              |
| `apps/web/src/components/ui/useNativePreviewOcclusion.ts`, `popover.tsx`, `menu.tsx`, `select.tsx`, `combobox.tsx`, `autocomplete.tsx`                                                                                                     | modify   | 6     | the new popup occlusion DOM test                                                                       |
| `apps/web/src/components/ui/usePopupOcclusion.ts` and its DOM test                                                                                                                                                                         | create   | 6     | the new popup occlusion DOM test                                                                       |
| `apps/web/src/components/chat/ProviderModelPicker.tsx`, its test and a new `ProviderModelPicker.real.test.tsx`; `apps/web/src/components/ChatMarkdown.tsx` and its test; `apps/web/src/components/files/FilePreviewPanel.tsx` and its test | modify   | 6     | Phase 6 checkpoint                                                                                     |
| `apps/server/src/diagnostics/host_metrics/volumes.rs`; `apps/server/src/auth/http.rs`, `apps/server/src/auth/service.rs`                                                                                                                   | modify   | 7     | Phase 7 checkpoint                                                                                     |
| `apps/server/tests/production_server_terminal_rpc.rs` (only if the R44 runs fail there)                                                                                                                                                    | modify   | 7     | the 50-run loop of Task 7.3                                                                            |
| `apps/desktop/e2e/wdio.conf.ts`, `apps/desktop/e2e/support/app-lifecycle.ts` and its test                                                                                                                                                  | modify   | 7     | `vp test run apps/desktop/e2e/support/app-lifecycle.test.ts`                                           |
| Lab images, VM runs, probe scripts (session scratch only)                                                                                                                                                                                  | external | 8     | log lines in `progress.md`                                                                             |
| `docs/skills/bibcode-profiler/references/events.md`, `docs/testing/**` (living runbooks), `docs/architecture/overview.md`, `docs/architecture/rpc-and-orchestration.md`, `CHANGELOG.md`                                                    | modify   | 9     | `vp run check:markdown-links`                                                                          |

Shared files reserved for the executor: `pnpm-lock.yaml`, `Cargo.lock`, `CHANGELOG.md` (written in Phase 9 only), the docs listed for Phase 9, `progress.md`.
Parallel conflicts: none. Round 1's seven phases own disjoint files. Two points to keep apart: Phase 1 alone edits `apps/server/src/lifecycle.rs` and `production/control.rs`; Phase 6 edits `components/ui/**` and Phase 4 must not. Phases 2, 3 and 7 and the two Rust tasks of Phase 1 are the Rust writers (4 at most at once).

## Traceability

| Requirement | Tasks                                                          |
| ----------- | -------------------------------------------------------------- |
| R1          | 1.1                                                            |
| R2          | 1.2                                                            |
| R3          | 1.3                                                            |
| R4          | 1.4                                                            |
| R5          | 1.10, 9.2                                                      |
| R6 to R11   | not planned: withdrawn from the spec, own folder for #350 (D2) |
| R12         | 5.1, 5.2, 8.3 (8.1 guards Linux)                               |
| R13         | 3.1, 8.3, 8.4                                                  |
| R14         | 7.1                                                            |
| R15         | 7.2, 8.1                                                       |
| R16         | 1.8                                                            |
| R17         | 1.5                                                            |
| R18         | 5.3                                                            |
| R19         | 8.2                                                            |
| R20         | 8.1                                                            |
| R21         | 2.1                                                            |
| R22         | 2.2                                                            |
| R23         | 2.3                                                            |
| R24         | 9.1                                                            |
| R25         | 9.1                                                            |
| R26         | 2.4, 9.1                                                       |
| R27         | 2.5                                                            |
| R28         | 2.6                                                            |
| R29         | 2.7                                                            |
| R30         | 2.8                                                            |
| R31         | 3.2                                                            |
| R32         | 3.3, 9.1                                                       |
| R33         | 3.4                                                            |
| R34         | 3.5                                                            |
| R35         | 4.2, 8.1                                                       |
| R36         | 4.3                                                            |
| R37         | 4.1                                                            |
| R38         | 4.5                                                            |
| R39         | 4.4                                                            |
| R40         | 6.1, 6.2                                                       |
| R41         | 1.6, 9.2                                                       |
| R42         | 1.7                                                            |
| R43         | 1.9                                                            |
| R44         | 7.3                                                            |
| R45         | 7.4                                                            |
| R46         | 6.3                                                            |
| R47         | 6.4                                                            |

## End-to-end verification

- `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test -p bibcode-server`, `cargo test -p bibcode-desktop`: exit 0 (Task 9.3).
- `vp check --no-fmt` on the whole tree and `vp check` on every changed file, `vp run typecheck`, `vp run test`, `vp run check:contracts`, `vp run check:markdown-links`: exit 0 (Task 9.3).
- Linux lab: the packaged default list passes with the Profiler on; the webview-kill and reload-marker checks pass; the R20 numbers are logged (Task 8.1).
- Windows VM: `chat-reasoning-rows` passes; the removal test passes in 12 of 12 whole-suite runs; fmt, Clippy, `vp check` and typecheck exit 0 (Task 8.3).
- Mac: the removal test passes 50 of 50 under load (Task 8.4); the hint test passes 50 of 50 under load or its failure is fixed (Task 7.3).
- Previous release's server: attach, resize and keybindings answer through their legacy paths (Task 8.2).
- Reviews of changed React against `vercel-react-best-practices` and of changed UI against `UI.md` (Task 9.3).

## Risks

- `allowProposedApi: true` for the Unicode addon turns on other proposed xterm APIs -> Task 1.10 lists what it enables and the reviewer judges it.
- Unicode 11 widths change how existing scrollback reflows and how wide characters sit at the margin -> Task 1.10's real-xterm test and the packaged terminal specs in Task 8.1.
- The R12 diagnosis may land outside the three suspected paths -> Task 5.1 records the scroll's caller before Task 5.2 chooses a fix; no fix is written before it.
- Rewriting two existing tests that assert the old behavior (R14's volume test, R27's "never stored" tests) could hide a regression -> each task states the old assertion it replaces and why.
- Lab time: the Windows VM's 12 whole-suite runs take hours -> Task 8.3 runs them unattended, one after the other, and nothing else waits on them except Phase 9.
- A decide-by-test item finds a real defect whose fix is larger than its task -> the task's fix branch is written in the phase file; anything beyond it becomes a new task in the same phase, logged as a Ruling.

## Decisions

- P1. #350 is closed as not planned and is outside this plan; the pull request closes the other nine issues and no longer waits. Decided by: user, 2026-11-13.
- P2. One plan folder for nine issues, one phase per file-ownership area rather than per issue, so that seven lanes can run at once without sharing a file. Alternatives: one phase per issue (three issues share `ThreadTerminalPanel.tsx`). Decided by: agent's call.
- P3. The baseline for Task 5.1 was taken during planning and is in the log: the harness sets a 1000x720 viewport itself and `chat-reasoning-rows` passes on Linux, so the live trace comes from Chromium at device pixel ratio 2 or from the Windows VM (Task 8.3 step 1, which runs as soon as Task 5.1 asks, ahead of the rest of Phase 8). Decided by: agent's call.
- P4. Skills were named from the session's installed list by the planner (`tdd`, `vercel-react-best-practices`, `better-interface`, `better-writing`, `mstack-diagnose`, `bibcode-profiler`); `mstack-find-skills` was not run for a wider search. A task runs without a specialist where its Skills line says "none". Decided by: agent's call.
- P5. Probe scripts for Task 8.2 are not committed: a one-off check does not earn a maintained script and its test. Decided by: agent's call.
- P6. The plan review is by Codex (`gpt-6.1-sol`, effort high), and approval follows the standing rule of spec D3. Decided by: user's standing rule.

## Appendix: questions record

- 2026-11-13 Q: Which issues, and how big is the batch? / Recommended: all open issues / Decision: answered by the request ("process all open issues ... fix them all in this PR").
- 2026-11-13 Q: Where does the plan go? / Recommended: `docs/plans/<date>-<slug>/`, the layout of the previous batch / Decision: resolved without asking.
- 2026-11-13 Evidence: five read-only verifiers against `main` at `a9938193b` / Decision: every item got a disposition (spec, opening section).
- 2026-11-13 Evidence: Codex review of the #350 design, verdict "needs rework" (`../2026-11-13-terminal-screen-350/reviews/design-review-1.md`) / Decision: P1; R1, R12 and R35 corrected from its findings 11, 12 and 13.
- 2026-11-13 Evidence: `git worktree list` succeeds from a readable repository when only a worktree's volume is missing (`worktree_audit.rs`, the prunable flag) / Decision: D9 uses the parent-directory gate.
- 2026-11-13 Evidence: lookups run only on status publications (`git_vcs.rs`), so nothing refreshes an idle branch / Decision: D7 ties expiry to a failed lookup.
