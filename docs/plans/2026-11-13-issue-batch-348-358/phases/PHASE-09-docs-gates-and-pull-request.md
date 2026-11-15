# Phase 9: Living docs, final gates and the pull request

- Goal: The living documentation matches the changed behavior, every completion gate of `AGENTS.md` has fresh evidence, and one pull request is open that closes exactly the issues whose every item has evidence.
- Round: 3
- Depends on: 1, 2, 3, 4, 5, 6, 7, 8
- Owns: `docs/skills/bibcode-profiler/references/events.md`, `docs/testing/**` (living runbooks only, not `reports/`), `docs/architecture/overview.md`, `docs/architecture/rpc-and-orchestration.md`, `CHANGELOG.md`
- Must not touch: product source and tests (a failing gate goes back to the phase that owns the file)
- Skills: better-writing (plain, exact wording in docs and the pull request body)
- Read first: `AGENTS.md` (Task Completion Requirements, Testing Runbook Maintenance, Profiler coverage, Sensitive Data); `docs/README.md` (the docs index and what counts as living documentation); `spec.md` (the dispositions each issue needs before it may be closed)
- Checkpoint: `vp run check:markdown-links` exits 0, every command of Task 9.3 exits 0, and the pull request's `Closes` list equals the issues whose items all have a log line with evidence.

## Tasks

### Task 9.1: Profiler and validation references

- Satisfies: R24, R25, and the documentation parts of R26 and R32
- Depends on: 2.4, 3.3
- Files: modify `docs/skills/bibcode-profiler/references/events.md`; modify `docs/testing/cross-platform-validation.md`
- Interfaces: consumes the quiesce step name `pull-request-lookups` (Task 2.4), the removal mode `create-rollback` with reason token `internal` (Task 3.3)
- Skills: better-writing (reference entries that state fields and timing exactly)
- Read first: `apps/server/src/production/runtime.rs` quiesce sequence (the real order of steps); `.github/workflows/ci.yml` test filter lines (the filters CI really runs)
- Tier: cheap
- TDD: exempt (documentation only)
- Done when: `rg -n "git-writes|pull-request-lookups" docs/skills/bibcode-profiler/references/events.md` finds both in the `server.stop` step list, `rg -n "create-rollback" docs/skills/bibcode-profiler/references/events.md` finds the mode, and `rg -n "background_status_|git_stop_|index_lock_cleanup_" docs/testing/cross-platform-validation.md` finds all three filters

Steps

1. [ ] In `events.md`, list `git-writes` and `pull-request-lookups` among the `server.stop` quiesce steps in the order `runtime.rs` runs them. Expected: the list matches the code's order.
2. [ ] In `events.md`, document the `worktree.removal` mode `create-rollback` and its reason token. Expected: the names equal the emitted ones.
3. [ ] In `cross-platform-validation.md`, add the three test filters next to the `quiesce_in_` line, with the note that a filter matching no test fails the step. Expected: the command equals the one in `ci.yml`.
4. [ ] Run `vp run check:markdown-links`. Expected: exit 0.

### Task 9.2: Architecture docs, runbooks and changelog

- Satisfies: R5, R41 (documented behavior), spec Verification (runbooks reviewed)
- Depends on: 9.1, 8.3
- Files: modify `docs/architecture/overview.md`; modify `docs/architecture/rpc-and-orchestration.md`; modify `docs/testing/cross-platform-validation.md` (webview recovery text); modify `docs/testing/linux-desktop.md`, `docs/testing/windows-desktop.md` and `docs/testing/macos-desktop.md` only where a procedure changed; modify `CHANGELOG.md`
- Interfaces: consumes the `terminalSizeHandOver` capability (Task 1.6) and the Unicode 11 width mode (Phase 1)
- Skills: better-writing (states guarantees and limits without marketing words)
- Read first: `docs/architecture/overview.md` terminal and Profiler sections (the text that now changes)
- Tier: standard
- TDD: exempt (documentation only)
- Done when: `vp run check:markdown-links` exits 0; `rg -n "terminalSizeHandOver" docs/architecture` finds the capability; the changelog's unreleased section names each user-visible change of this batch; and the task's log line lists each runbook as changed or "reviewed and remains accurate"

Steps

1. [ ] Update `overview.md` where this batch contradicts it: (a) the pull-request lookup text that says a failure is never reused now states the 5-second failure backoff and that a remembered request is cleared by a failed lookup once its last success is more than 5 minutes old; (b) the terminal text that gates the size hand-over on `terminalUserInputClaim` now names `terminalSizeHandOver`; (c) terminals count widths by Unicode 11, a new terminal retries WebGL after an earlier failure, and the development size record exists and holds no content; (d) the quiesce sequence names the `pull-request-lookups` step. Expected: `rg -n "never reused|terminalUserInputClaim" docs/architecture/overview.md` shows no sentence that contradicts the code.
2. [ ] Update `rpc-and-orchestration.md` with the `terminalSizeHandOver` capability and what a client does without it. Expected: names equal the contracts in `packages/contracts/src`.
3. [ ] In `docs/testing/cross-platform-validation.md`, replace the text that describes worker-only webview recovery and cascading failures after a web process crash with the per-test probe and its single overall deadline. Then review the three desktop runbooks against the changed procedures. Change what is stale; record the others as reviewed and accurate. Expected: no execution-specific numbers are added to a living runbook.
4. [ ] Add the unreleased changelog entries, one line per user-visible change, in the file's existing style. Expected: no issue is described as fixed that the log does not prove.
5. [ ] Run `vp run check:markdown-links`. Expected: exit 0.

### Task 9.3: Final gates and reviews

- Satisfies: support (the spec's Verification section, for every task of phases 1 to 8)
- Depends on: 9.2
- Files: none (a failing gate reopens the owning task)
- Interfaces: consumes the integrated branch; produces the validation table for the pull request body
- Skills: vercel-react-best-practices (required review of every changed React component and hook); better-interface (the `UI.md` review of every changed screen, dialog and notice)
- Read first: `UI.md` (the design-quality review); `AGENTS.md` Task Completion Requirements (the full list)
- Tier: most capable
- TDD: exempt (a pure command run and two reviews with recorded results)
- Done when: each command below exits 0 on the integrated head and the log holds the React review, the `UI.md` review, the profiler coverage line and the sensitive-data check

Steps

1. [ ] Put the pinned Rust toolchain first on `PATH` and run `cargo fmt --all --check`. Expected: exit 0.
2. [ ] Run `cargo clippy --workspace --all-targets -- -D warnings`. Expected: exit 0.
3. [ ] Run `cargo test -p bibcode-server` and `cargo test -p bibcode-desktop`. Expected: 0 failed.
4. [ ] Run `vp check --no-fmt` on the whole tree, `vp check <every changed file>`, `vp run typecheck`, `vp run test`, `vp run check:contracts` and `vp run check:markdown-links`, as the spec's Verification section states. Expected: exit 0 each. Whole-tree `vp check` runs in CI on a clean checkout; locally the desktop app's ignored settings file fails its formatting step.
5. [ ] Review every changed component and hook under `apps/web` against `vercel-react-best-practices`, and every changed screen, dialog, notice and message against `UI.md`. Expected: each finding is fixed in its owning task or logged with the reason it stays.
6. [ ] Write the profiler coverage line: which items of the `AGENTS.md` coverage list the batch touches (a new quiesce step, a new removal mode, new warn logs) and how each stays covered. Expected: one line per item.
7. [ ] Read `git diff main...HEAD --stat` and `git status --short`, and search the added lines, commit messages and plan files for local machine paths, private hosts, real names and credentials. Expected: none; no generated or debug file is in the diff.

### Task 9.4: Reviews before the push, then the pull request

- Satisfies: support (D1: one pull request, for every task of phases 1 to 8)
- Depends on: 9.3
- Files: none
- Interfaces: consumes the validation table of Task 9.3 and the lab tables of Phase 8; produces one pull request
- Skills: better-writing (a pull request body that states limits and what was not run)
- Read first: the body of the previous batch's pull request (the house format: per-issue table, limits, validation table, not run, profiler, runbooks)
- Tier: most capable
- TDD: exempt (review and publication, no behavior)
- Done when: the pull request exists, its `Closes` list names only issues whose every item has evidence in the log, the others are listed under `Refs` with what is missing, and the session is bound to the pull request with CI followed by the app's Auto-fix

Steps

1. [ ] Get a read-only Codex review of the whole branch against `main` and a second opinion from the advisor; verify each finding against the code before accepting it. Expected: every accepted finding is fixed with a test that failed first, and every rejected one has its reason in the log.
2. [ ] Rerun the commands of Task 9.3 that the fixes can affect. Expected: exit 0.
3. [ ] Push the branch once (a later push cancels the running CI) and open the pull request with the house format. Expected: the body has no local path, private host or real name.
4. [ ] Bind the pull request to the session and let Auto-fix do the waiting; a cheap helper reads failed job logs and bot comments, and only decisions come back to the main session. Expected: no auto-merge is turned on.
