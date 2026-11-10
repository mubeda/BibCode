# Issue batch: pipeline headers, Git reliability, rich Markdown editing and custom themes

Status: Approved 2026-11-09 (approved in chat by the user)
Spec: spec.md (Status line: Approved 2026-11-09 (approved in chat by the user, with amendments A1 and A2), sha256 c6b1062039a1)
Repository: this repository
Base: main

## Goal

- A person's own Git commands work while BiBCode is open, status stays live during a push, a failed remote push says where to sign in, and the profiler stops warning about folders that were never worktrees (#341, #345, #343, #344).
- Pipeline stages read as group labels, a Markdown file is edited in rendered view with a formatting toolbar, and a person picks or builds a color theme in Settings (#340, #342, #290).
- One pull request closes all seven issues, with every requirement of `spec.md` proven by a test.

## Global constraints

- No real host, organization, person or machine path in code, tests, fixtures, commits or the pull request. Use `example-server`, `gitlab.example.test`, `test-user`. (spec Constraints; AGENTS.md Sensitive Data)
- Every requirement is proven by a script, a test or the WebDriver suite. No step needs a person at a screen. (spec Constraints)
- Hang budget 10 seconds; default Git timeout 30 seconds; push transfer limit 600 seconds; audit interval 600 seconds. None of them changes. (spec Constraints; R23)
- Clean-stop grace 2 seconds and lock-unchanged wait 2 seconds. (D13; R15, R16)
- The stored mode key `bibcode:theme` and its values `system`, `light`, `dark` do not change. (spec Constraints; R38)
- A theme file is at most 16 KiB, the library holds at most 64 custom themes, a theme name has 1 to 48 characters, radius is 0 to 1rem, focus ring width 1 to 3px and offset 0 to 3px. (R36, R48, R59)
- Text pairs at least 4.5:1 and control borders at least 3:1, binding the four new built-in themes only. (R56, D20)
- The pre-paint step stays an external script; the desktop content policy allows no inline script. (spec Constraints)
- The guidance text of R8 is used word for word.
- Design notes for #342 and #290 land with the code and count as approved once Codex and the advisor have reviewed them. (D3)
- Server tests use the real Git runner, an isolated Git configuration, disposable repositories and a Git host on `127.0.0.1`. (spec Constraints)
- No production Node runtime and no new sidecar process. (AGENTS.md Package Roles)
- Never commit `.codegraph/` data. Never edit files under `.repos/`. (AGENTS.md)

## Spec amendments made during planning

Both were found by the plan review and approved by the user on 2026-11-09; `spec.md` carries them.

- A1 (R58). Diagrams take their colors from the info, background and foreground tokens, not from primary, and both preview bridges ignore the annotation theme today. R58's scenario now checks diagrams on the tokens they use and checks the annotation reader's values; wiring the bridges is left to a follow-up issue.
- A3 (R55, approved by the user in chat on 2026-11-09 during execution). Built-in Light already fails placeholder on background at about 3.1:1, so the literal rule would strip the background of nearly every light import. A fixed pair is reset only when it is below 4.5:1 and below the same pair at the base theme's values.
- A2 (Verification of R1 and R2). The packaged-app screenshot of the pipeline detail view is dropped, because the end-to-end fixture has no pipeline host. R1 and R2 are proven by component tests.

## Review focus

1. A lock-free statistics read that misreports changes: a file whose timestamp changed but whose content did not must not appear, and a real edit must. Pinned by Task 2.1 (`background_status_keeps_unstaged_statistics_correct`).
2. Two writes in one worktree after reads resume: the worktree entry must not be retired and recreated while the write lock is held. Pinned by Task 3.1 (`a_worktree_with_a_held_lock_is_not_retired`).
3. Removing a lock another Git process just took: the lock must predate nothing and stay unchanged for 2 seconds. Pinned by Task 2.3 (`index_lock_cleanup_keeps_a_lock_that_changes_during_the_wait`).
4. A rendered-view save that rewrites untouched Markdown: Windows line endings, a missing final newline and unusual fences must survive. Pinned by Task 6.3 (`reconcileMarkdown` cases a, b, d and f).
5. A theme value that reaches the page as something other than a color: stored data edited by hand must be re-checked by the pre-paint script. Pinned by Task 7.2 (injection tests) and Task 7.6 (`a value containing url( or var( in the paint record is not applied`).

## Out of scope

- Signing in to Git on a remote server from the client (#343 P1): needs its own secret-handling design.
- Shortcuts, image paste, slash-menu extras, `.mdx` rich editing and a third preview mode (#342): follow once the toolbar set works.
- The sidebar-hierarchy extension of #290: moved to its own issue, filed by Task 8.5.
- Custom syntax colors, importing themes from other apps, server-side theme sync, a theme CLI (#290 P2).
- The pull-request checks tab (#340): a different renderer.
- Pull and fetch gating (#345): pull rewrites files at its end.
- A UI warning for stale locks (#341): cleaning up BiBCode's own lock covers the case.
- Deleting, moving or registering the folder reported in #344.

## Sources

- Repository rules: `AGENTS.md` (delivery discipline, required pre-work, sensitive data, runbook maintenance, profiler coverage, architectural standards, completion requirements, package roles); `CLAUDE.md` (points to `AGENTS.md`); `UI.md` (design review for every changed screen)
- Repository docs: `docs/README.md` (index); `docs/architecture/overview.md` (profiler section, package boundaries); `docs/architecture/rpc-and-orchestration.md` (mutation and status-read contract, changed by Phase 3); `docs/architecture/worktree-catalog.md` (orphan rule, changed by Phase 5); `docs/skills/bibcode-profiler/references/findings.md` (finding reference, changed by Phase 5); `docs/operations/observability.md` (log lines, changed by Phase 2); `docs/user/workspace-ui.md` (user guide, changed by Phase 8); `docs/testing/README.md`, `docs/testing/cross-platform-validation.md`, `docs/testing/macos-desktop.md`, `docs/testing/linux-desktop.md`, `docs/testing/windows-desktop.md` (how the packaged suite runs; reviewed by Phase 8); `docs/reference/scripts.md` (commands); `docs/reference/workspace-layout.md`; `docs/plans/README.md` (dated design notes are historical snapshots); `docs/plans/2026-11-07-git-manager-interactive-sign-in-design.md` (sign-in eligibility boundary and the house format for design notes); `docs/skills/issue-delivery/SKILL.md` (acceptance evidence before costly runs)
- Plan folder: `spec.md` (binding); `theme-palettes.md` (binding built-in theme values)
- External: GitHub issues #340, #341, #342, #343, #344, #345 and #290 of this repository (read in full on 2026-11-09; they contain real names, so nothing is copied from them into the repository); Orca at commit `94dab9fc697be8c1ea6dc94c13661d9f7ca23980` (MIT; the toolbar commands, the `details` extension and the source-preserving save are ported from it by Phase 6)

## Stack and commands

- Server: Rust, Axum and Tokio in `apps/server`. Tests `cargo test -p bibcode-server -j 2` (one target with `--test <name>`, unit tests with `--lib <filter>`); format `cargo fmt --all --check`; lint `cargo clippy --workspace --all-targets -- -D warnings`. Source: `.github/workflows/ci.yml` lines 161-167 and `apps/server/package.json`. Use the `rustup` toolchain the repository pins.
- Web: React and Vite in `apps/web`. One test file, from `apps/web`: `node ../../scripts/run-local-vp.mjs test run --project unit <path>`; whole suite `vp run --filter @bibcode/web test`. Source: `AGENTS.md` and `apps/web/package.json`.
- Contracts: Effect Schema in `packages/contracts`. `vp run check:contracts`.
- Scripts and the pre-paint script: `vp test run scripts`.
- Whole repository: `vp check`, `vp run typecheck`, `vp run test`, `vp run check:dependency-ledger`, `vp run check:markdown-links`.
- Desktop end-to-end: `vp run test:ui:desktop:build`, then `vp run test:ui:desktop`; one spec with `BIBCODE_E2E_SPEC=./specs/<name>.e2e.ts`. Source: `docs/testing/README.md`.
- Not run during planning: the suites take minutes to tens of minutes and need a full dependency install in this worktree. Each command above was read from the cited source, and the first task of every phase runs its own command before changing code.

## Phases

| Phase | File | Goal | Round | Depends on | Tier |
|---|---|---|---|---|---|
| 1 | phases/PHASE-01-pipeline-stage-headers.md | Stage headers read as group labels (#340) | 1 | none | standard |
| 2 | phases/PHASE-02-background-git-index-locks.md | Background Git never blocks the person's Git and leaves no lock (#341) | 1 | none | most capable |
| 3 | phases/PHASE-03-status-during-push.md | Status is delivered while a push waits (#345) | 2 | 2 | most capable |
| 4 | phases/PHASE-04-remote-push-guidance.md | A failed remote push says where to sign in (#343) | 3 | 3 | most capable |
| 5 | phases/PHASE-05-orphan-worktree-warnings.md | Orphan warnings need worktree evidence (#344) | 4 | 4 | most capable |
| 6 | phases/PHASE-06-rich-markdown-editing.md | Markdown is editable in rendered view (#342) | 1 | none | most capable |
| 7 | phases/PHASE-07-custom-themes.md | Built-in and custom color themes (#290) | 1 | none | most capable |
| 8 | phases/PHASE-08-end-to-end-docs-gates.md | End-to-end proof, documents, gates, follow-up issue | 5 | 1, 2, 3, 4, 5, 6, 7 | standard |

Phases in the same round run in parallel. A phase depends only on phases in earlier rounds. Tasks inside a phase run one after another, in the order their Depends on lines give: one lane per phase, never one lane per task. The four server phases (2, 3, 4, 5) are a chain because they share `repository.rs`, `git_vcs.rs` and `manager/operations.rs`. Run at most one lane that compiles Rust at a time, and check `df -h .` for at least 60 GB free before a lane starts a build.

## File map

| Path or external change | Action | Phase | Verification |
|---|---|---|---|
| `apps/web/src/components/pipelines/detail/PipelineStageColumns.tsx` | modify | 1 | web test `PipelinesDetailView.test.tsx` |
| `apps/web/src/components/pipelines/detail/PipelinesDetailView.test.tsx` | modify | 1 | itself |
| `apps/server/src/git/repository.rs` | modify | 2 | `cargo test -p bibcode-server --lib background_status_` |
| `apps/server/src/git/process.rs` | modify | 2 | `cargo test -p bibcode-server --lib index_lock_cleanup_` |
| `apps/server/src/process/**` and every `SupervisedRunRequest` initializer in `apps/server/src` (one new field) | modify | 2 | `cargo test -p bibcode-server --lib git_stop_`, `cargo check -p bibcode-server --all-targets` |
| `apps/server/src/production/runtime.rs` | modify | 2 | `cargo test -p bibcode-server --lib index_lock_cleanup_` |
| `.github/workflows/ci.yml` | modify | 2 | the Windows and macOS jobs run the `background_status_` and `index_lock_cleanup_` filters |
| `docs/operations/observability.md` | modify | 2 | `vp run check:markdown-links` |
| `apps/server/src/git/status_owner.rs`, `apps/server/src/git/broadcaster.rs` | modify | 3 | `cargo test -p bibcode-server --lib status_owner` |
| `apps/server/src/diagnostics/profiler/latency.rs` | modify | 3 | `cargo test -p bibcode-server --lib a_status_refresh_blocked` |
| `apps/server/src/production/git_vcs.rs`, `apps/server/tests/production_git_vcs_rpc.rs` | modify | 3 | `cargo test -p bibcode-server --lib held_pu`, `cargo test -p bibcode-server --test production_git_vcs_rpc a_real_commit_survives` |
| `apps/server/src/git/manager/operations.rs` | modify | 3 | `cargo test -p bibcode-server --lib manager_transfer_gate` |
| `docs/architecture/rpc-and-orchestration.md`, `docs/architecture/overview.md` | modify | 3 | `vp run check:markdown-links` |
| `apps/server/src/git/sign_in.rs`, `apps/server/src/production/git_manager_rpc.rs` | modify | 4 | `cargo test -p bibcode-server --lib sign_in` |
| `apps/server/tests/support/git_http_auth_host.rs`, `apps/server/tests/remote_push_guidance.rs` | create | 4 | `cargo test -p bibcode-server --test remote_push_guidance` |
| `apps/web/src/components/GitActionsControl.tsx` and its test | modify | 4 | web test `GitActionsControl.test.tsx` |
| `apps/web/src/components/gitManager/toolbar/GitManagerOperationBanner.tsx` and its test | modify | 4 | web test `GitManagerOperationBanner.test.tsx` |
| `apps/web/src/components/SourceControlPanel.tsx`, `apps/web/src/components/gitManager/GitManagerPanel.tsx` and their tests | modify | 4 | web tests `SourceControlPanel.test.tsx`, `GitManagerPanel.test.tsx` |
| `apps/server/src/persistence/migrations.rs` (migration 72, a stored-data change) | modify | 5 | `cargo test -p bibcode-server --lib migration_72` |
| `apps/server/src/persistence/repositories.rs` | modify | 5 | `cargo test -p bibcode-server --lib worktree_creation_record` |
| `apps/server/src/production/worktree_catalog_rpc.rs` | modify | 5 | `cargo test -p bibcode-server --lib worktree_creation_record` |
| `apps/server/src/diagnostics/profiler/worktree_audit.rs` | modify | 5 | `cargo test -p bibcode-server --lib worktree_audit` |
| `apps/server/tests/profiler_worktree_audit.rs` | modify | 5 | `cargo test -p bibcode-server --test profiler_worktree_audit` |
| `docs/architecture/worktree-catalog.md`, `docs/skills/bibcode-profiler/references/findings.md` | modify | 5 | `vp run check:markdown-links` |
| `docs/plans/2026-11-09-files-rich-markdown-toolbar-design.md` | create | 6 | reviewed, Status line set |
| `apps/web/src/components/files/fileEditingSession.ts` and its test | modify | 6 | web test `fileEditingSession.test.ts` |
| `apps/web/src/components/files/filePreviewMode.ts` | modify | 6 | web test `markdownSupport.test.ts` |
| `apps/web/src/components/files/richMarkdown/**` (surface, extensions, format group, link popover, image hook, reconcile and support modules, fixtures, styles, tests) | create | 6 | web tests under `src/components/files/richMarkdown` |
| `apps/web/src/components/files/FilePreviewPanel.tsx`, `FileEditorToolbar.tsx`, `fileTransfers.ts` and their tests | modify | 6 | web tests under `src/components/files` |
| `apps/web/package.json`, `pnpm-lock.yaml` (new editor packages, a dependency change) | modify | 6 | `vp run check:dependency-ledger` |
| `docs/dependency-upgrades/2026-07-17-ledger.json` | modify | 6 | `vp run check:dependency-ledger` |
| `docs/plans/2026-11-09-custom-themes-design.md` | create | 7 | reviewed, Status line set |
| `packages/contracts/src/theme.ts`, `packages/contracts/src/theme.test.ts` | create | 7 | `vp test run packages/contracts/src/theme.test.ts` |
| `packages/contracts/src/index.ts` | modify | 7 | `vp run check:contracts` |
| `apps/web/src/themes/**` (validation, color parser and resolver, base values, built-in files, store, transfer, tests) | create | 7 | web tests under `src/themes` |
| `apps/web/src/index.css`, `apps/web/src/themeTokens.test.ts` | modify | 7 | web tests `src/themes/tokens.test.ts`, `src/themeTokens.test.ts` |
| `apps/web/src/hooks/useTheme.ts` and its test | modify | 7 | web test `useTheme.test.ts` |
| `apps/web/public/theme-bootstrap.js`, `scripts/lib/theme-bootstrap.ts`, `scripts/lib/theme-bootstrap.test.ts` | modify | 7 | `vp test run scripts/lib/theme-bootstrap.test.ts` |
| `apps/web/src/components/terminalTheme.ts` and its test, `ThreadTerminalPanel.tsx`, `ChatView.tsx` (terminal call sites only) | modify | 7 | web test `terminalTheme.test.ts` |
| `apps/web/src/components/pipelines/log/jobLogStyle.ts` and its test, `JobLog.tsx` | modify | 7 | web test `jobLogStyle.test.ts` |
| `apps/web/src/components/settings/**` (Appearance panel, theme editor, color field, import dialog, nav, panels, tests) | create and modify | 7 | web tests under `src/components/settings` |
| `apps/web/src/routes/settings.appearance.tsx` (create), `apps/web/src/routes/settings.tsx`, `apps/web/src/routeTree.gen.ts` (generated) | create and modify | 7 | `vp run typecheck` |
| `apps/web/src/components/ui/input.tsx`, `select.tsx`, `button.tsx`, `badge.tsx`, `apps/web/src/components/chat/ComposerPrimaryActions.tsx` (marker attribute only), and the selected-state class in the files Task 7.3 step 1 lists | modify | 7 | web tests under `src/components/ui` |
| `apps/web/src/browser/annotationTheme.ts` and its test | modify | 7 | web test `annotationTheme.test.ts` |
| `apps/desktop/e2e/specs/files-rich-markdown.e2e.ts`, `apps/desktop/e2e/specs/appearance-themes.e2e.ts` | create | 8 | `vp run test:ui:desktop` with `BIBCODE_E2E_SPEC` |
| `apps/desktop/e2e/wdio.conf.ts` | modify | 8 | `vp run test:ui:desktop` |
| `docs/user/workspace-ui.md`, `docs/testing/cross-platform-validation.md` | modify | 8 | `vp run check:markdown-links` |
| `apps/web/THIRD_PARTY_NOTICES.md` | modify | 8 | read against the two design notes |
| `CHANGELOG.md` | modify | 8 | read |
| One new GitHub issue for the sidebar-hierarchy extension (external change) | create | 8 | `gh issue list --search "sidebar hierarchy in:title"` |

Three files have a second, later owner by design, and the phases are in different rounds so they never run together: `apps/server/src/production/git_vcs.rs` (Phase 3, then Phase 4 for the failure message, then Phase 5 for the creation-record calls) and `apps/server/src/git/manager/operations.rs` (Phase 3, then Phase 4), and `apps/server/src/production/runtime.rs` (Phase 2 for shutdown, then Phase 4 for the service construction). `apps/web/src/components/pipelines/detail/PipelineStageColumns.tsx` and its test are changed again by Task 8.4 in round 5.

Shared files reserved for the executor: `progress.md` of this folder. Phase 6 alone changes `apps/web/package.json`, `pnpm-lock.yaml` and the dependency ledger. Phase 8 alone changes `CHANGELOG.md`, `apps/web/THIRD_PARTY_NOTICES.md`, `docs/user/workspace-ui.md` and `apps/desktop/e2e/wdio.conf.ts`.

Parallel conflicts: round 1 runs Phases 1, 2, 6 and 7. They share no path: Phase 7 must not touch `components/pipelines/detail/**` (Phase 1) or `components/files/**` (Phase 6), and Phase 6 keeps its styles out of `index.css` (Phase 7). Rounds 2 to 5 have one phase each.

## Traceability

| Requirement | Tasks |
|---|---|
| R1 | 1.1 |
| R2 | 1.1 |
| R3 | 5.2 |
| R4 | 5.1 |
| R5 | 5.2 |
| R6 | 5.2 |
| R7 | 5.2 |
| R8 | 4.1 |
| R9 | 4.2 |
| R10 | 4.1 |
| R11 | 4.1 |
| R12 | 4.1 |
| R13 | 8.3 |
| R14 | 2.1 |
| R15 | 2.2 |
| R16 | 2.3 |
| R17 | 2.3 |
| R18 | 3.2 |
| R19 | 3.3 |
| R20 | 3.1, 3.2 |
| R21 | 3.2, 3.3 |
| R22 | 3.2 |
| R23 | 3.1 |
| R24 | 6.5 |
| R25 | 6.9, 6.4, 8.1 |
| R26 | 6.5 |
| R27 | 6.6 |
| R28 | 6.7 |
| R29 | 6.4, 8.1 |
| R30 | 6.2, 6.4, 8.1 |
| R31 | 6.3, 6.9, 8.1 |
| R32 | 6.8, 6.4 |
| R33 | 6.3 |
| R34 | 6.8, 6.9, 6.4 |
| R35 | 6.5 |
| R36 | 7.2 |
| R37 | 7.4, 7.6, 8.2 |
| R38 | 7.3, 7.5 |
| R39 | 7.5, 7.6 |
| R40 | 7.8 |
| R41 | 7.6, 8.2 |
| R42 | 7.6, 8.2 |
| R43 | 7.8 |
| R44 | 7.8, 8.2 |
| R45 | 7.8 |
| R46 | 7.8 |
| R47 | 7.9, 8.2 |
| R48 | 7.2 |
| R49 | 7.5 |
| R50 | 7.3, 8.4 |
| R51 | 7.7, 7.14 |
| R52 | 7.9 |
| R53 | 7.10 |
| R54 | 7.9 |
| R55 | 7.10 |
| R56 | 7.4 |
| R57 | 7.11 |
| R58 | 7.11 |
| R59 | 7.12 |
| R60 | 7.8 |
| R61 | 7.5 |

## End-to-end verification

- `vp check`, `vp run typecheck` and `vp run test` exit 0.
- `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings` and `cargo test -p bibcode-server -j 2` exit 0.
- `vp run check:contracts`, `vp run check:dependency-ledger` and `vp run check:markdown-links` exit 0, with no diff under `packages/contracts/fixtures`.
- `BIBCODE_E2E_SPEC=./specs/files-rich-markdown.e2e.ts vp run test:ui:desktop` and `BIBCODE_E2E_SPEC=./specs/appearance-themes.e2e.ts vp run test:ui:desktop` exit 0 against a packaged build of the final branch.
- After the branch is pushed at the user's request, the Windows and macOS CI jobs pass the `background_status_` and `index_lock_cleanup_` steps added by Tasks 2.1 and 2.3.
- `vp test run scripts` exits 0, including the sensitive-data guard.
- Both design notes exist with an Approved status line and a Review handling section.

## Risks

- The cause of #341 is inferred from Git's source. -> Task 2.1 starts with a failing reproduction and has a stop-and-rule step if the reproduction passes before the fix.
- Reopening status reads touches the code that prevents concurrent writes. -> Task 3.1 pins the invariants in isolation before any caller uses the new method.
- No local Git host that requires authentication exists in the tests. -> Task 4.1 builds one from `git http-backend`; if `git http-backend` is missing on a CI image, the stored-credential test is skipped there with a logged reason and the guidance tests still run against a plain 401 answer.
- One reconcile of a file near the preview size limit has no measured time bound. -> Task 6.1's design note sets a budget and what happens above it; if the note needs a size limit for rich editing, that is a spec change to bring to the user.
- About ten new editor packages. -> Task 6.1 records each license and size, and the editor is loaded lazily.
- A rendered-view save can rewrite Markdown. -> Task 6.3 is a pure module with byte-comparison tests, written before any editor code.
- A worktree creation now fails when its creation record cannot be stored. -> Task 5.1 rolls the worktree back and tests the failure, so no worktree exists without evidence.
- The selected-state switch of Task 7.3 touches shared list components. -> Defaults make `--selected` equal `--accent`, and the web suite runs after the switch.
- `is_managed_orphaned_worktree_path` in `repository.rs` still treats any unowned child as an orphan. -> Left unchanged on purpose: it guards removal, not the profiler warning, and changing it is outside #344. Reported as a residual risk by Task 8.5.
- The end-to-end fixture has no pipeline host, so the pipeline detail view cannot be captured in the packaged app. -> Spec amendment A2: R1 and R2 are proven by component tests.
- Four lanes in round 1 and several Rust builds can exhaust the disk. -> One Rust lane at a time and a 60 GB check before each build.

## Decisions

- P1. Eight phases in five rounds, with the server phases chained and the three web phases beside them. Alternatives: one phase per round (slow); all phases parallel (they share three server files). Decided by: user (outline approved 2026-11-09).
- P2. Files that several issues need (`docs/user/workspace-ui.md`, `apps/web/THIRD_PARTY_NOTICES.md`, `CHANGELOG.md`, `apps/desktop/e2e/wdio.conf.ts`) are changed only by Phase 8. Alternatives: each phase edits them (parallel conflicts). Decided by: user (outline).
- P3. Both end-to-end specs are written and run in Phase 8 on the combined branch. Alternatives: one packaged build per feature phase (tens of minutes each, twice). Decided by: user (outline).
- P4. On Windows a Git process is stopped by force as today, and Task 2.3's lock removal covers a leftover lock. Alternatives: a console break event to the process group (not dependable for a process without a console). Decided by: agent's call, allowed by R15's Windows scenario.
- P5. Insert image needs no server change: the client retries the upload under the next numbered name when the host answers that the name exists. Alternatives: a new server call that picks the name (a contract change for one caller). Decided by: user (outline).
- P6. The pre-paint script reads one precomputed record (`bibcode:theme-paint:v1`) instead of the library, because built-in themes are modules the script cannot import. Alternatives: duplicating the built-in values inside the script (two sources of truth). Decided by: agent's call.
- P13. New color tokens get their default as a fallback inside the `@theme inline` mapping, not as a root declaration, so a default follows a base token that a subtree overrides. Alternatives: root declarations (a placeholder inside a dark sidebar card would keep the root's muted color). Decided by: agent's call, from the advisor's review.
- P14. A mutation queued behind a push whose local writes are finished closes the read gate only when it acquires the lock, because background work also takes the mutation guard. Alternatives: keep the gate closed while anything is queued (the #345 wait returns whenever an agent write queues behind a push). Decided by: agent's call, from the advisor's review.
- P15. Shutdown stops and awaits every running Git write through a registry before the profiler teardown, so R17 holds on Windows where the stop is forced. Alternatives: waiting only for cleanups already in flight (a write still running at shutdown would be dropped with its lock). Decided by: agent's call, from the advisor's review.
- P7. Focus ring and control shadow are themed by CSS rules scoped to root attributes that restyle the real ring and shadow owners (the input wrapper, the button and its pseudo-elements, the Send button), which get marker attributes. Alternatives: replacing ring classes in the roughly 60 files that carry them (large diff, conflicts with every other phase); rules on `:focus-visible` alone (they miss the input wrapper's ring and the pseudo-element shadows). Decided by: agent's call, corrected by the plan review.
- P16. A theme color is a hex color, `rgb()`, `hsl()` or `oklch()`. Named colors and other functions are rejected. This is narrower than the spec's "a CSS color" and lets one parser serve validation, contrast, previews and the pre-paint record. Alternatives: accepting everything `CSS.supports` accepts (the pre-paint script and the contrast math could not check it the same way). Decided by: agent's call, approved by the user on 2026-11-09.
- P17. A new built-in theme whose default placeholder color falls below 4.5:1 on its background sets `placeholder` to its own muted-foreground (Tokyo Night `#8c94bb`, Matrix Light `#3f6b4a`). This adds a value to the binding palettes so R56 holds. Alternatives: leaving the 72 percent default (about 3.63:1 and 3.33:1). Decided by: agent's call, approved by the user on 2026-11-09.
- P18. The pre-paint record is derived data, rebuilt from the library and slots when missing, unreadable or stale, and holds only hex colors, bounded lengths and fixed keywords under an allowlist of property names. Decided by: agent's call, from the plan review.
- P20. Shutdown closes Git write admission, stops and awaits running writes through a registry shared by every runner of the runtime, and does not report a clean stop while a cleanup is pending. Decided by: agent's call, from the second plan review.
- P21. A rich edit waiting on the 300 ms timer is delivered through a flusher the session calls before save, settle, view switch, file switch, rename and reload. Decided by: agent's call, from the second plan review.
- P22. The pre-paint script applies a cached paint record only when its stamp matches the slots record, so an interrupted write paints the built-in base, never a stale theme. Decided by: agent's call, from the second plan review.
- P23. The plan names the test-first skill `test-driven-development`; a host that lists it as `tdd` uses that one. Decided by: agent's call.
- P19. `ExecutionPlace` is built once at server construction and handed to the VCS service and the Git Manager service. Decided by: agent's call, from the plan review.
- P8. The spec says the repository has no notices file; `apps/web/THIRD_PARTY_NOTICES.md` exists. The plan extends it and leaves the approved spec text as it is. Decided by: user (outline).
- P9. R13's help text is written by Task 8.3, so Phase 4 has two tasks. After the plan review split four oversized tasks (6.8, 6.9, 7.13, 7.14), the plan has 39 tasks; the outline had 36. Decided by: agent's call, following P2.
- P10. Task 8.5 files one follow-up issue for the sidebar-hierarchy extension. It does not push or open the pull request. Decided by: user (outline).
- P11. Skills: no gap was found, so nothing was proposed for install. Test-first work uses `test-driven-development`, bug phases `mstack-diagnose`, React changes `vercel-react-best-practices` (required by AGENTS.md), interface work `ui-ux-pro-max` and `better-accessibility`, and the repository's own `issue-delivery` and `bibcode-profiler`. Decided by: agent's call.
- P12. The plan review runs through the Codex CLI directly, because the `codex` skill of the skill-codex plugin is not installed and the CLI is logged in. Decided by: agent's call.

## Appendix: questions record

- 2026-11-09 Q: Where should the plan go? / Recommended: `docs/plans/2026-11-09-issue-batch-340-345-290/` / Decision: accepted.
- 2026-11-09 Q: Which spec? / Recommended: write one first with `mstack-write-specs` / Decision: accepted; approved the same day.
- 2026-11-09 Q: Any sources outside the repository and the issues? / Recommended: none / Decision: none.
- 2026-11-09 Q: Reviewer model and effort? / Recommended: `gpt-6.1-sol`, high / Decision: accepted.
- 2026-11-09 Q: Is the outline right (phases, rounds, tasks, the decisions P1 to P3, P5, P8, P10)? / Recommended: yes / Decision: approved.
- 2026-11-09 Evidence: `.github/workflows/ci.yml` lines 405-416 / Decision: the Windows and macOS jobs compile the server and run one named test, so Task 2.1 adds its filter to both jobs.
- 2026-11-09 Evidence: `apps/server/tests` and `apps/server/src/git/manager/operations/sign_in_tests.rs` / Decision: no authenticated Git host fixture exists, so Task 4.1 creates one.
- 2026-11-09 Evidence: `apps/server/src/process/supervised.rs` lines 539-600 / Decision: every stop is a forced kill today, so Task 2.2 adds the stop policy.
- 2026-11-09 Evidence: `apps/server/src/git/status_owner.rs` lines 438, 497 and 1203 / Decision: publication requires that no mutation is active, so reads cannot simply run during a push; Task 3.1 adds a lock-held flag.
- 2026-11-09 Evidence: `apps/server/src/persistence/migrations.rs` line 673 / Decision: the next migration number is 72.
- 2026-11-09 Evidence: `apps/web/src/components/files/fileEditingSession.ts` lines 340-345 and 605 / Decision: `changeOutsideEditor` drops source history, so Task 6.2 adds a separate entry point for rich edits.
- 2026-11-09 Evidence: `apps/web/src/components/files/useFileTransfers.ts` and `packages/contracts/src/transfer.ts` line 26 / Decision: the upload call takes a directory and a file name and answers 409 for a taken name, which is enough for Insert image.
- 2026-11-09 Evidence: `apps/desktop/src-tauri/tauri.conf.json` lines 27-29 / Decision: `script-src 'self'` forbids an inline pre-paint script.
- 2026-11-09 Evidence: `apps/web/src/components/markdown/mermaidRenderer.ts` and `apps/web/src/index.css` lines 814-832 / Decision: diagrams take colors from CSS variables, so R58 needs a test and no diagram code.
- 2026-11-09 Evidence: `rg` counts in `apps/web/src` (ring classes in about 60 files) / Decision: P7.
- 2026-11-09 Evidence: `apps/web/THIRD_PARTY_NOTICES.md` exists / Decision: P8.
