# Progress: Issue batch: pipeline headers, Git reliability, rich Markdown editing and custom themes

Plan: plan.md
Spec: spec.md (sha256 f2e9f8422896)
Plan status: Approved 2026-11-09
Plan review: Codex gpt-6.1-sol (effort high), round 2 of 2, Needs rework; 14 findings handled in reviews/plan-review-2.md (round 1: 18 findings, reviews/plan-review-1.md)
Executor: mstack-codex-review-workflow
Branch: claude/next-pr-planning-13d367

| Task | Title | Phase | State | Owner | Note |
|---|---|---|---|---|---|
| 1.1 | Restyle the stage header as a group label | 1 | Open | | |
| 2.1 | Prove the lock source and make background reads lock-free | 2 | Open | | |
| 2.2 | Ask Git to stop before killing it | 2 | Open | | |
| 2.3 | Remove BiBCode's own leftover lock and leave none at shutdown | 2 | Open | | |
| 3.1 | Let a mutation reopen status reads while it keeps the write lock | 3 | Open | | |
| 3.2 | Stacked actions deliver status while the push waits | 3 | Open | | |
| 3.3 | Git Manager push-family operations deliver status; pull and fetch do not | 3 | Open | | |
| 4.1 | Server guidance for a remote missing-credentials push | 4 | Open | | |
| 4.2 | Show the guidance and keep Git's line readable in both surfaces | 4 | Open | | |
| 5.1 | Record the worktrees BiBCode creates | 5 | Open | | |
| 5.2 | Warn only for folders with worktree evidence | 5 | Open | | |
| 6.1 | Write and review the design note | 6 | Open | | |
| 6.2 | Let the session take rich edits without losing source history | 6 | Open | | |
| 6.3 | Source-preserving reconcile | 6 | Open | | |
| 6.4 | Editable rendered surface on the existing save path | 6 | Open | | |
| 6.5 | Formatting group and its commands | 6 | Open | | |
| 6.6 | Link dialog | 6 | Open | | |
| 6.7 | Insert image | 6 | Open | | |
| 6.8 | Frontmatter split and the read-only rule | 6 | Open | | |
| 6.9 | Editor packages, schema and a faithful round trip | 6 | Open | | |
| 7.1 | Write and review the design note | 7 | Open | | |
| 7.2 | Theme file format and validation | 7 | Open | | |
| 7.3 | New color tokens that default to today's look | 7 | Open | | |
| 7.4 | Built-in theme files and the contrast check | 7 | Open | | |
| 7.5 | Theme library and slots store | 7 | Open | | |
| 7.6 | Apply a theme, and paint it before the app appears | 7 | Open | | |
| 7.7 | New terminal sessions follow the theme when asked to | 7 | Open | | |
| 7.8 | Appearance section, theme list and its actions | 7 | Open | | |
| 7.9 | Theme editor with live preview, terminal colors and contrast warnings | 7 | Open | | |
| 7.10 | Export and import | 7 | Open | | |
| 7.11 | Scrollbars, sidebar text, diagrams and annotation colors follow the theme | 7 | Open | | |
| 7.12 | Focus ring and control shadow tokens | 7 | Open | | |
| 7.13 | One color parser and one token resolver | 7 | Open | | |
| 7.14 | The pipeline job log follows the terminal palette | 7 | Open | | |
| 8.1 | Desktop end-to-end test for rich Markdown editing | 8 | Open | | |
| 8.2 | Desktop end-to-end test for themes | 8 | Open | | |
| 8.3 | User guide, runbooks and notices | 8 | Open | | |
| 8.4 | Last token switch and changelog | 8 | Open | | |
| 8.5 | Final gates, follow-up issue and report | 8 | Open | | |

## Log
