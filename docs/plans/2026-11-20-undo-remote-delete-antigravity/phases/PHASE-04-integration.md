# Phase 4: Integration and pull request

- Goal: The four feature phases are integrated on one branch, reviewed, every follow-up is ticketed and fixed, the final commit passes every gate, and one pull request is open.
- Round: 2
- Depends on: 1, 2, 3, 5
- Owns: `docs/plans/2026-11-20-undo-remote-delete-antigravity/progress.md`, `docs/plans/README.md`, `docs/user/workspace-ui.md`, `docs/testing/**`, any file a follow-up fix needs
- Must not touch: `.repos/**`, `.codegraph/**`
- Skills: issue-delivery (acceptance checklist and a checkpoint before costly runs)
- Read first: `AGENTS.md` › Task Completion Requirements; `docs/testing/README.md`; `docs/operations/ci.md`; `scripts/check-agent-delivery.mjs` (what the checkpoint must hold)
- Checkpoint: every command in `plan.md` › End-to-end verification exits 0 on the commit that is pushed, and the pull request lists issues #397, #398, #399, #400 and every follow-up issue as closed by it.

## Tasks

### Task 4.1: Integrate, review and fix follow-ups

- Satisfies: R15
- Depends on: 1.2, 1.3, 2.3, 3.10, 5.1
- Files: modify `docs/user/workspace-ui.md`; modify `docs/plans/README.md`; modify the testing runbooks under `docs/testing/` that the change affects; modify any file a follow-up fix needs
- Interfaces: consumes the three phase branches and their task reports; produces one candidate commit on the plan's branch
- Skills: mstack-receive-review (processes the Codex and advisor reviews); better-writing (the user guide text)
- Read first: the task reports of phases 1, 2, 3 and 5 (Rulings, "not run" items, the user-visible text for the guide); `docs/user/workspace-ui.md:1224-1243` (remote rows are described as checkout only today) and its AI Terminal notes
- Tier: standard
- TDD: red-green
- Done when: `git status --short` is empty on the plan's branch, `gh issue list --repo mubeda/BibCode --state open --json number,title` shows every follow-up issue with a fix commit named in `progress.md`, and both reviews are logged with every finding handled

Rules for this task

- One sequence for inline and workflow execution: integrate (a no-op inline), review, fix, commit the candidate. The final Codex and advisor reviews happen here, before the gates of Task 4.2, never after them.
- `docs/user/workspace-ui.md`'s AI Terminal notes link to `docs/providers/antigravity.md` (spec R14); `vp run check:markdown-links` proves the link. Expected: exit 0.

Steps

1. [ ] Integrate the phase branches into the plan's branch, in the order 5, 2, 3, 1. Run `git status --short`. Expected: clean, no conflict markers.
2. [ ] Update `docs/user/workspace-ui.md`: remote branch rows offer Delete with the default-branch rule, and the AI Terminal notes list Antigravity as a terminal whose status is unavailable, and View PR is described as opening the PR panel. Review the testing runbooks the change affects (the packaged UI suite gained a spec; provider visibility gained a driver; typography fixtures if they changed) and update them, or record that they were reviewed and remain accurate. Add this plan folder to `docs/plans/README.md`.
3. [ ] Get a Codex read-only review of `git diff origin/main...HEAD` against `spec.md`, and an advisor review. Process both with `mstack-receive-review`.
4. [ ] For every accepted finding and every follow-up (a Ruling, a deferred finding, a "not run" that is real work, a failure seen outside the changed areas): file a GitHub issue with `gh issue create` (placeholders only), write the test that fails, run it. Expected: FAIL. Fix it, run it again. Expected: PASS. Log the issue number with its fix commit in `progress.md`.
5. [ ] Review `git diff origin/main...HEAD` for unintended edits, debug output, leftover logging from Task 1.1, and sensitive data. Expected: none. Commit; this commit is the candidate.

### Task 4.2: Gate the candidate commit and open the pull request

- Satisfies: R15
- Depends on: 4.1
- Files: modify `docs/plans/2026-11-20-undo-remote-delete-antigravity/progress.md`
- Interfaces: consumes the candidate commit of Task 4.1; produces the pull request
- Skills: bibcode-profiler (reads the Profiler data of the packaged run)
- Read first: `docs/testing/macos-desktop.md`; `docs/skills/bibcode-profiler/SKILL.md`; `docs/skills/issue-delivery/SKILL.md`
- Tier: standard
- TDD: exempt (verification and publication; it runs commands and adds no behavior)
- Done when: `gh pr view --repo mubeda/BibCode --json state,headRefOid,closingIssuesReferences` shows an open pull request whose head is the gated commit and which closes #397, #398, #399, #400 and every follow-up issue, and the six End-to-end verification results are logged in `progress.md` with that commit's SHA

Rules for this task

- Gate evidence does not move the gated commit: the results and the gated SHA go into the pull request body. The commit that closes this task in `progress.md` touches only that file, is made after the gates, and is not gated again. Any other change after the gates restarts this task from step 1.

Steps

1. [ ] Run `git rev-parse HEAD` and log the SHA as the gated commit. Expected: the candidate of Task 4.1.
2. [ ] Run `vp check`, `vp run typecheck`, `cargo fmt --all --check` and `cargo clippy -p bibcode-server -p bibcode-desktop --all-targets -- -D warnings`. Expected: exit 0 for each.
3. [ ] Run `vp run -r --concurrency-limit 1 test`. Expected: exit 0.
4. [ ] Write the issue-delivery checkpoint outside the repository, with `source` and `proof.source` set to the gated SHA and `proof.scope` `complete-caller`, and run `node scripts/check-agent-delivery.mjs <checkpoint file>`. Expected: exit 0. Then take the build lock, run `vp run test:ui:desktop:build`, and run `BIBCODE_E2E_PROFILER=1 vp run test:ui:desktop`. Expected: PASS, with `files-undo-shortcuts.e2e.ts` named in the run report.
5. [ ] Load `bibcode-profiler` and read that run's Profiler data. Expected: no new finding.
6. [ ] If any of steps 2 to 5 fails or finds something: go back to Task 4.1 step 4 for it, commit, and repeat this task from step 1 on the new commit. The gates are valid only for the SHA they ran on.
7. [ ] Run `git push -u origin HEAD` and open one pull request against `main` with `gh pr create`, whose body closes #397, #398, #399, #400 and the follow-up issues, lists each validation command with its result and the gated SHA, what was not run and why, the spec decisions that were the planning agent's calls (D1, D5, D7, D9, D12, plan decision P10, and D8, which the research first advised against), and the profiler coverage line (child processes: `agy` is spawned only by the terminal runtime; RPC methods: none added; removal paths: none; the chat refusal logs through `tracing::warn!`; on Task 1.2 branch B, the menu action reuses the existing event). Expected: the Done when command shows the pull request open on the gated commit. Publishing is authorized by the owner's request for this pull request; follow CI with cheap helpers, one run at a time.
