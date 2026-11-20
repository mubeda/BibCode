# Progress: Files undo shortcuts, remote branch delete, Antigravity terminal

Plan: plan.md
Spec: spec.md (sha256 9d9513bbe595)
Plan status: Approved 2026-11-20
Plan review: Codex gpt-6.2-sol at high, round 2, Needs rework; all 25 findings of both rounds handled (reviews/), no third round
Executor: none
Branch: claude/backlog-triage-planning-pr-b5ee7f

| Task | Title                                                                         | Phase | State | Owner | Note |
| ---- | ----------------------------------------------------------------------------- | ----- | ----- | ----- | ---- |
| 1.1  | Reproduce the failure and locate it per platform                              | 1     | Open  |       |      |
| 1.2  | Fix the located path and prove it in the packaged app                         | 1     | Open  |       |      |
| 1.3  | Pin the chord behavior in web tests and correct the tooltip                   | 1     | Open  |       |      |
| 2.1  | Make the dialogs and the dropdown read the server's guard names               | 2     | Open  |       |      |
| 2.2  | Mark each remote's default branch on the server                               | 2     | Open  |       |      |
| 2.3  | Delete a remote branch from the branch list                                   | 2     | Open  |       |      |
| 3.1  | Write and review the Antigravity terminal design note                         | 3     | Open  |       |      |
| 3.2  | Register the antigravity driver in settings, inventory and the hermetic lists | 3     | Open  |       |      |
| 3.3  | Refuse a chat start for an Antigravity instance on the server                 | 3     | Open  |       |      |
| 3.4  | Offer Antigravity Terminal and never an Antigravity chat in the client        | 3     | Open  |       |      |
| 3.5  | Document the Antigravity terminal                                             | 3     | Open  |       |      |
| 4.1  | Integrate, review and fix follow-ups                                          | 4     | Open  |       |      |
| 5.1  | Route View PR to the panel and keep a browser menu item                       | 5     | Open  |       |      |
| 4.2  | Gate the candidate commit and open the pull request                           | 4     | Open  |       |      |

## Log

- 2026-11-20 08:15 Plan written from issues #397, #398, #399. Outline and questions took the recommended defaults (plan.md, P4).
- 2026-11-20 08:30 Plan review 1 (Codex) and an advisor review processed. Undo is diagnosed before any fix, the remote default comes from the server, sign-in is shared with the toolbar, Antigravity registration and chat routing widened, gates moved to the final commit.
- 2026-11-20 08:33 Research report on the Antigravity CLI and SDKs added as research-antigravity.md, with an addendum on how Orca launches it.
- 2026-11-20 08:36 Issue #400 (View PR opens the browser) filed at the owner's request and planned as phase 5.
- 2026-11-20 08:50 Plan review 2 (Codex) and a second advisor review processed; corrections folded into the tasks. The round 2 fixes were not reviewed again.
