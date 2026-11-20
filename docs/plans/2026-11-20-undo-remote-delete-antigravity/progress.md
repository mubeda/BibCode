# Progress: Files undo shortcuts, remote branch delete, Antigravity terminal

Plan: plan.md
Spec: spec.md (sha256 3f5d29373cba)
Plan status: Approved 2026-11-20
Plan review: Codex gpt-6.2-sol at high, round 2, Needs rework; all 25 findings of both rounds handled (reviews/), no third round
Executor: mstack-codex-review-workflow
Branch: claude/backlog-triage-planning-pr-b5ee7f

| Task | Title                                                                         | Phase | State       | Owner  | Note                                                         |
| ---- | ----------------------------------------------------------------------------- | ----- | ----------- | ------ | ------------------------------------------------------------ |
| 1.1  | Reproduce the failure and locate it per platform                              | 1     | In progress | lane A | measured on three platforms; in review                       |
| 1.2  | Fix the located path and prove it in the packaged app                         | 1     | In progress | lane A | macOS fix committed; Codex review running                    |
| 1.3  | Pin the chord behavior in web tests and correct the tooltip                   | 1     | In progress | lane A | committed; Codex review running                              |
| 2.1  | Make the dialogs and the dropdown read the server's guard names               | 2     | In progress | lane B | review round 1: 9 findings being fixed                       |
| 2.2  | Mark each remote's default branch on the server                               | 2     | In progress | lane B | review round 1: 9 findings being fixed                       |
| 2.3  | Delete a remote branch from the branch list                                   | 2     | In progress | lane B | review round 1: 9 findings being fixed                       |
| 3.1  | Write and review the Antigravity terminal design note                         | 3     | In progress | lane D | note reviewed; revised after live probes                     |
| 3.2  | Register the antigravity driver in settings, inventory and the hermetic lists | 3     | In progress | lane D | committed 2225ede7d; Codex review running                    |
| 3.6  | Add the Antigravity ACP session runtime                                       | 3     | In progress | lane F |                                                              |
| 3.7  | Dispatch Antigravity chats in the provider runtime                            | 3     | In progress | lane F | after 3.6                                                    |
| 3.8  | Probe Antigravity sign-in state and models in the inventory                   | 3     | In progress | lane G |                                                              |
| 3.9  | Offer Antigravity Terminal and Antigravity chat in the client                 | 3     | In progress | lane E | terminal and Settings first; chat part waits for 3.7 and 3.8 |
| 3.10 | Document Antigravity everywhere the providers are listed                      | 3     | Open        |        |                                                              |
| 4.1  | Integrate, review and fix follow-ups                                          | 4     | Open        |        |                                                              |
| 5.1  | Route View PR to the panel and keep a browser menu item                       | 5     | Closed      | lane C | accepted after one review round                              |
| 4.2  | Gate the candidate commit and open the pull request                           | 4     | Open        |        |                                                              |

## Log

- 2026-11-20 08:15 Plan written from issues #397, #398, #399. Outline and questions took the recommended defaults (plan.md, P4).
- 2026-11-20 08:30 Plan review 1 (Codex) and an advisor review processed. Undo is diagnosed before any fix, the remote default comes from the server, sign-in is shared with the toolbar, Antigravity registration and chat routing widened, gates moved to the final commit.
- 2026-11-20 08:33 Research report on the Antigravity CLI and SDKs added as research-antigravity.md, with an addendum on how Orca launches it.
- 2026-11-20 08:36 Issue #400 (View PR opens the browser) filed at the owner's request and planned as phase 5.
- 2026-11-20 08:50 Plan review 2 (Codex) and a second advisor review processed; corrections folded into the tasks. The round 2 fixes were not reviewed again.
- 2026-11-20 08:55 Workflow started. Lanes A (1.1 to 1.3), B (2.1 to 2.3), C (5.1) and D (3.1, 3.2) In progress. Tasks 3.3 to 3.5 held for the owner's answer on chat over ACP.
- 2026-11-20 08:59 Ruling by the owner: the Antigravity chat provider over ACP is built in this pull request. Spec R13 and D9 are reversed; lane D designs the chat provider in the Task 3.1 note, and the coordinator rewrites the spec and Tasks 3.3 to 3.5 from that note (new task IDs from 3.6), with a Codex and advisor review of the revision before those tasks start. Cost if wrong: a larger pull request.
- 2026-11-20 09:10 5.1 Closed. Evidence: focused web tests on the three files, 216 passed (11 failed before the fix); `vp check --no-fmt` clean; `npx tsc --noEmit` clean. Codex review: 3 findings, all fixed (repository mismatch falls back to the browser, Done handler uses the combined check, fallback tests click View). Lane branch worktree-agent-a095c372d3e446d48, commits a17efc10f..78046e199. Not integrated yet.
- 2026-11-20 09:16 Owner's instruction: every living document that lists the supported providers must name Antigravity. The replanned documentation task covers at least README.md (intro line and the provider setup list), docs/README.md, docs/providers/README.md plus a new docs/providers/antigravity.md, docs/getting-started/provider-setup.md, docs/architecture/providers.md and overview.md, docs/user/workspace-ui.md, docs/reference/encyclopedia.md, the docs/testing runbooks that state provider visibility, and CHANGELOG.md. Dated plans, reports and docs/superpowers are history and stay as they are.
- 2026-11-20 09:50 Replanned phase 3 for the chat over ACP: Tasks 3.3 to 3.5 removed, Tasks 3.6 to 3.10 added from the lane D design note (plan.md P12; spec R13, R14 and D9 rewritten). A live `agy` 1.5.13 `initialize` and `session/new` on the development machine (no prompt sent) confirmed protocol 1, resume and load, the option ids `model`, `thought_level` and `mode`, and the modes `default`, `accept-edits`, `auto` and `plan`.
- 2026-11-20 09:50 1.1 macOS measured: disposition B (the predefined Edit items take the chord before the page). Design note `docs/plans/2026-11-20-edit-menu-undo-design.md` is in Codex and advisor review; Windows and Linux measurements running. Lane branch worktree-agent-a24bd2b8983f9f3fe.
- 2026-11-20 10:00 Plan review 3 (Codex, Needs rework, 11 findings) processed with an advisor review pending; findings folded into the rules of Tasks 3.6 to 3.10 (reviews/plan-review-3.md). The fixes were not reviewed again.
- 2026-11-20 10:10 Advisor review of the revision processed: the effort id corrected to `reasoning` from source, the chat is spawned without the bypass flag, and a second live probe (no prompt) measured option changes, close, resume and load; the facts are in the phase 3 rules.
- 2026-11-20 10:26 Owner allows live `agy` testing with a cheap model and asks that the chat panel's model list be checked against what the CLI advertises. One live turn (file write with one approval, cheapest fast model) was captured for fixtures; the packaged check is step 5a of Task 4.2.
- 2026-11-20 12:40 Lane A: 1.1 measured on macOS (B), Windows (C) and Linux (C; menu N). Design revision 2 accepted after Codex and advisor review; 1.2 and 1.3 committed (macOS packaged spec 38 of 38), Codex review of the diff running; Windows and Linux re-measurement pending. Follow-ups filed: #408 (Linux plain text fields do not undo) and #409 (packaged E2E probes real tools), both assigned to lane A.
- 2026-11-20 12:40 Lane B: 2.1 to 2.3 committed with follow-ups #401 to #404; Codex review round 1 requested changes (9 findings, all accepted); fixes in progress. Ruling refining P10: a remote that answers with no HEAD has no default to protect and the delete proceeds; an unreachable remote, a HEAD without a symref and the default branch are refused.
- 2026-11-20 12:40 Lane D ended after 3.1 and 3.2 (context used up). Lanes F (3.6, 3.7), G (3.8) and E (3.9) started from its branch worktree-agent-adec49c6f98e2e169.
