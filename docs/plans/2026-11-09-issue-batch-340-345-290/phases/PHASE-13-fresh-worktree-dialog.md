# Phase 13: A fresh Create worktree dialog

- Goal: Every opening of Create worktree starts a new creation, with context and saved preferences as its only defaults, while input survives a failure and Create more keeps its batch options (#346, amendment A12).
- Round: 5
- Depends on: 10
- Owns: `apps/web/src/components/CreateWorktreeDialog.tsx`, `apps/web/src/components/CreateWorktreeDialog.logic.ts`, `apps/web/src/components/CreateWorktreeDialog.test.tsx`, `apps/web/src/components/CreateWorktreeDialog.dom.test.tsx`, `apps/web/src/components/Sidebar.testHarness.tsx` and the Sidebar tests that use it
- Shared files: `CHANGELOG.md`, `docs/user/workspace-ui.md`, `docs/testing/cross-platform-validation.md` (Phases 8, 11 and 12 change them too; the coordinator integrates this phase's commits in sequence)
- Must not touch: server code, contracts, settings persistence, any other dialog
- Skills: mstack-diagnose (a failing reproduction before any theory); test-driven-development; vercel-react-best-practices (AGENTS.md requires it for the changed component)
- Read first: `spec.md` R106 to R109 and D50; GitHub issue #346 (its field table is static analysis, to be confirmed by the reproduction); `UI.md` (defaults, preserving user work); `docs/user/workspace-ui.md` (the Create worktree passage that promises same-project source retention)
- Checkpoint: from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/components/CreateWorktreeDialog.dom.test.tsx` exits 0; in the app, a worktree created from a branch with a typed name leaves an empty dialog at the next opening.

## Tasks

### Task 13.1: Reproduce, find the cause, and reset at the opening boundary

- Satisfies: R106 (reopen after a successful creation; reopen after dismissal; the next creation borrows nothing), R107 (another project, and no context; the saved agent wins over an earlier manual pick), R108 (failure, pending and refresh), R109 (batch, then a fresh opening)
- Depends on: none
- Files: modify `apps/web/src/components/CreateWorktreeDialog.tsx`; modify `apps/web/src/components/CreateWorktreeDialog.test.tsx`; modify `apps/web/src/components/Sidebar.testHarness.tsx` and one Sidebar test file
- Interfaces: consumes the dialog's `open`, project and `onOpenChange` props and the create command it dispatches; produces no new names, exports, settings or persisted state.
- Skills: mstack-diagnose; test-driven-development
- Read first: the two existing tests that pin same-project source reuse and stale-source retention on reopen (they are replaced), and the tests of issues #136, #151 and #185 (they stay green)
- Tier: most capable
- TDD: red-green
- Done when: from `apps/web`, `node ../../scripts/run-local-vp.mjs test run --project unit src/components/CreateWorktreeDialog.dom.test.tsx` exits 0 with the new reopen tests passing

Steps

1. [ ] Write a mounted test that creates a worktree with a typed name, Branch mode, a picked source and a base override, lets creation succeed, and opens the dialog again on the same mounted instance, asserting the fields of R106. Run the command under Done when. Expected: FAIL, the previous values are still shown.
2. [ ] Confirm the cause with one probe per claim (the form state outlives the close; the opening effect resets only some fields; the full reset runs only for Create more; retained source text re-selects its branch) and record, per field, what was measured.
3. [ ] Extend the closed-to-open initialization so every opening starts fresh, without a remount key and without persisted state; keep the pending-submit guard and same-opening edit protection.
4. [ ] Add the tests for dismissal, the next command's payload, project and agent defaults, failure and refresh, and Create more; replace the two tests that pin the old policy; add one Sidebar test with the real dialog. Run the command under Done when and the Sidebar tests. Expected: PASS.
5. [ ] Prove the main reopen test can fail: revert the fix, run the command. Expected: FAIL. Restore and run again. Expected: PASS.
6. [ ] Run `pnpm exec tsc --noEmit` in `apps/web` and `vp check`. Expected: no errors.

### Task 13.2: User guide, runbook scenario and changelog

- Satisfies: support (documentation of R106 to R109; the user guide promised the opposite)
- Depends on: 13.1
- Files: modify `docs/user/workspace-ui.md`; modify `docs/testing/cross-platform-validation.md`; modify `CHANGELOG.md`
- Interfaces: consumes the behavior of Task 13.1; produces no names.
- Skills: none
- Read first: the Create worktree passage of `docs/user/workspace-ui.md`; the worktree checks in `docs/testing/cross-platform-validation.md`
- Tier: cheap
- TDD: exempt (documentation only, no behavior to test)
- Done when: `vp run check:markdown-links` exits 0 and `rg -c "#346" CHANGELOG.md` prints 1 or more

Steps

1. [ ] Rewrite the user guide passage: every opening starts fresh; Create more keeps the batch's options until the dialog is closed.
2. [ ] Add the fresh-opening scenario beside the existing worktree checks in the cross-platform runbook, and one changelog line under Unreleased ending with the issue number.
3. [ ] Run `vp run check:markdown-links`. Expected: no errors.
