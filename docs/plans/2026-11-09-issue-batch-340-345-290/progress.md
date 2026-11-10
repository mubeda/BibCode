# Progress: Issue batch: pipeline headers, Git reliability, rich Markdown editing and custom themes

Plan: plan.md
Spec: spec.md (sha256 295a5b4e58e6)
Plan status: Approved 2026-11-09
Plan review: Codex gpt-6.1-sol (effort high), round 2 of 2, Needs rework; 14 findings handled in reviews/plan-review-2.md (round 1: 18 findings, reviews/plan-review-1.md)
Executor: mstack-codex-review-workflow
Branch: claude/next-pr-planning-13d367

| Task | Title | Phase | State | Owner | Note |
|---|---|---|---|---|---|
| 1.1 | Restyle the stage header as a group label | 1 | Closed | A, sonnet | 58 tests pass; Codex finding fixed |
| 2.1 | Prove the lock source and make background reads lock-free | 2 | In progress | B, opus | |
| 2.2 | Ask Git to stop before killing it | 2 | In progress | B, opus | |
| 2.3 | Remove BiBCode's own leftover lock and leave none at shutdown | 2 | In progress | B, opus | |
| 3.1 | Let a mutation reopen status reads while it keeps the write lock | 3 | Open | | |
| 3.2 | Stacked actions deliver status while the push waits | 3 | Open | | |
| 3.3 | Git Manager push-family operations deliver status; pull and fetch do not | 3 | Open | | |
| 4.1 | Server guidance for a remote missing-credentials push | 4 | Open | | |
| 4.2 | Show the guidance and keep Git's line readable in both surfaces | 4 | Open | | |
| 5.1 | Record the worktrees BiBCode creates | 5 | Open | | |
| 5.2 | Warn only for folders with worktree evidence | 5 | Open | | |
| 6.1 | Write and review the design note | 6 | In progress | C, opus | |
| 6.2 | Let the session take rich edits without losing source history | 6 | In progress | C, opus | |
| 6.3 | Source-preserving reconcile | 6 | In progress | C, opus | |
| 6.4 | Editable rendered surface on the existing save path | 6 | In progress | C, opus | |
| 6.5 | Formatting group and its commands | 6 | In progress | C, opus | |
| 6.6 | Link dialog | 6 | In progress | C, opus | |
| 6.7 | Insert image | 6 | In progress | C, opus | |
| 6.8 | Frontmatter split and the read-only rule | 6 | In progress | C, opus | |
| 6.9 | Editor packages, schema and a faithful round trip | 6 | In progress | C, opus | |
| 7.1 | Write and review the design note | 7 | In progress | D, opus | Done when green; Codex review running |
| 7.2 | Theme file format and validation | 7 | In progress | D, opus | Done when green; Codex review running |
| 7.3 | New color tokens that default to today's look | 7 | In progress | D, opus | Done when green; Codex review running |
| 7.4 | Built-in theme files and the contrast check | 7 | In progress | D, opus | Done when green; Codex review running |
| 7.5 | Theme library and slots store | 7 | In progress | D, opus | Done when green; Codex review running |
| 7.6 | Apply a theme, and paint it before the app appears | 7 | In progress | D, opus | Done when green; Codex review running |
| 7.7 | New terminal sessions follow the theme when asked to | 7 | In progress | D, opus | Done when green; Codex review running |
| 7.8 | Appearance section, theme list and its actions | 7 | In progress | D, opus | Done when green; Codex review running |
| 7.9 | Theme editor with live preview, terminal colors and contrast warnings | 7 | In progress | D2, opus | |
| 7.10 | Export and import | 7 | In progress | D2, opus | |
| 7.11 | Scrollbars, sidebar text, diagrams and annotation colors follow the theme | 7 | In progress | D2, opus | |
| 7.12 | Focus ring and control shadow tokens | 7 | In progress | D2, opus | |
| 7.13 | One color parser and one token resolver | 7 | In progress | D, opus | Done when green; Codex review running |
| 7.14 | The pipeline job log follows the terminal palette | 7 | In progress | D, opus | Done when green; Codex review running |
| 8.1 | Desktop end-to-end test for rich Markdown editing | 8 | Open | | |
| 8.2 | Desktop end-to-end test for themes | 8 | Open | | |
| 8.3 | User guide, runbooks and notices | 8 | Open | | |
| 8.4 | Last token switch and changelog | 8 | Open | | |
| 8.5 | Final gates, follow-up issue and report | 8 | Open | | |

## Log
- 2026-11-09 22:30 Executor set to mstack-codex-review-workflow on branch claude/next-pr-planning-13d367. Round 1 lanes started: A (phase 1, sonnet medium), B (phase 2, opus medium), C (phase 6, opus medium), D (phase 7, opus medium). Codex reviews run through the codex CLI directly; the skill-codex `codex` skill is not installed.
- 2026-11-09 22:35 Ruling: spec amendment A3 to R55 (fixed pair resets only when below 4.5:1 and below the base's ratio), approved by the user in chat, because built-in Light fails placeholder on background. Spec hash updated to c6b1062039a1. Cost if wrong: imports could keep a low-contrast pair the base already has.
- 2026-11-09 22:35 Ruling: lane D widens Task 7.3 to switch the selected-state class in 13 more files (bg-accent to bg-selected only), because R50's selected-row scenario needs real rows on the token and no running lane owns them. Cost if wrong: a selected row's look changes in a custom theme where it should not.
- 2026-11-09 22:35 1.1 review: Codex found dark-mode header contrast about 4.2:1 (verified); sent back to lane A.
- 2026-11-09 22:40 1.1 Closed. Evidence: `node ../../scripts/run-local-vp.mjs test run --project unit src/components/pipelines/detail/PipelinesDetailView.test.tsx` 58 passed, exit 0; web tsc clean; vp check clean on changed files. Codex review (gpt-6.1-sol high): 1 finding (dark contrast), fixed in 94ab16343. Lane branch worktree-agent-ab2ff06bccd18a273, commits 2c9d3a7f6..94ab16343, cherry-picked onto claude/next-pr-planning-13d367. Phase 1 checkpoint met by the same command.
- 2026-11-09 23:10 Lane D stopped at its context limit with 7.1-7.8, 7.13, 7.14 committed on worktree-agent-a178413587db40372 (58a695135..ca31bc282), each Done when green per its report (checkpoint 947 tests, scripts 921 passed). Retry after a context limit: narrowed scope to fresh lane D2 (opus medium, same tier) for 7.9-7.12 and the phase-end React, UI.md and web-ui reviews, based on lane D's branch. Codex review of 7.1-7.8 started.
- 2026-11-09 23:20 Codex review of 7.1-7.8 (gpt-6.1-sol high): 4 findings. Accepted and sent to lane D2: (1) running terminal repaints with fallback after a base switch (R51), (2) fixed terminal preference inherits custom app surfaces (R51), (3) repair() trusts matching stamps and keeps a corrupt paint record (P18). Rejected: (4) pressed color needs hover on keyboard and touch, because today's primary button has the same hover gate and R50 requires defaults to equal today.
- 2026-11-10 05:25 Lane C closed 6.1-6.9 (worktree-agent-a66281ebfa0dbb832, 92b650778..585d0c12d; checkpoint 566 tests). Codex review (gpt-6.1-sol high): 5 findings, all accepted (disk-check overwrite, empty details reconcile throw, save shortcut after lazy load, image name encoding, refused file stays read-only). Ruling: spec amendment A4 (R34, files over 128 KiB open read-only in rendered view), approved by the user, because lane C measured 7.1 s per parse at 1 MB. Lane C2 (opus medium, fresh after a large context) fixed all six on worktree-agent-afbe62a3c38c1d9b1 (e6da61754..7ffc3cfde; checkpoint 579 tests). Codex re-review of C2 running.
- 2026-11-10 05:25 Lane D2 closed 7.9-7.12 and the three accepted Codex findings on worktree-agent-a4a968458e29a61df (c1e8dd6dc..c62b7642e; checkpoint 982 tests, web suite 10879 passed). D2 measured that A3 still strips off-white backgrounds (#fffdf8 placeholder 3.08 vs Light 3.11). Ruling: amendment A3 revised by the user: a pair the base already fails is reset only when the import overrides its text token. Lane D3 (sonnet medium) implements it.
- 2026-11-10 05:25 Lane B closed 2.1-2.3 on worktree-agent-a538a0a03bb1d7dd5 (9761ab7a5..fa843c1aa; lib suite 5272 passed, clippy and fmt clean; mstack-diagnose root cause Confirmed: unstaged `git diff --numstat` refreshes the index). Codex review (gpt-6.1-sol high): 4 findings accepted (cleanup ownership on drop, quiesce reporting Ok with pending writes, drop restarting the stop grace, failed lock deletion counted as clean). Lane B2 (opus medium) fixes them, reusing lane B's target dir.
