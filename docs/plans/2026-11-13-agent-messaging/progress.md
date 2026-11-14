# Progress: Send to agent and agent messaging

Plan: plan.md
Spec: spec.md (sha256 d3eed2efe3ec)
Plan status: Approved 2026-11-13
Plan review: Codex gpt-6-astra (high), round 2, Needs rework; findings handled, fixes after round 2 not reviewed again
Executor: mstack-codex-review-workflow
Branch: claude/bibcode-inter-agent-communication-1bc0ff

| Task | Title | Phase | State | Owner | Note |
|---|---|---|---|---|---|
| 1.1 | Send request record and store | 1 | Closed | lane 1A | Two Codex reviews, 5 findings fixed (lanes 1B, 1C); integrated |
| 1.2 | Person-only send operation | 1 | Closed | lane 1A | Two Codex reviews, 5 findings fixed (lanes 1B, 1C); integrated |
| 1.3 | Request states from turn events | 1 | Closed | lane 1B | Two Codex reviews, 5 findings fixed (lanes 1B, 1C); integrated |
| 1.4 | Contracts for send requests | 1 | Closed | lane 1A | Two Codex reviews, 5 findings fixed (lanes 1B, 1C); integrated |
| 1.5 | Retry and replay of a person's send | 1 | Closed | lane 1B | Two Codex reviews, 5 findings fixed (lanes 1B, 1C); integrated |
| 1.6 | Cancel, dismiss, subscribe and answer retrieval | 1 | Closed | lane 1B | Two Codex reviews, 5 findings fixed (lanes 1B, 1C); integrated |
| 2.1 | Control, menu and agent list | 2 | Closed | lane 2 | Codex review, 3 fixes accepted; branch worktree-agent-a2389b1ddd118699a |
| 2.2 | Preview and Message send | 2 | Closed | lane 2 | Codex review, 3 fixes accepted; branch worktree-agent-a2389b1ddd118699a |
| 2.3 | Person-send label in the transcript | 2 | Closed | lane 2 | Codex review, 3 fixes accepted; branch worktree-agent-a2389b1ddd118699a |
| 2.4 | Request state row | 2 | Closed | lane 2 | Codex review, 3 fixes accepted; branch worktree-agent-a2389b1ddd118699a |
| 3.1 | Review action | 3 | Closed | lane 3 | Codex review, 5 fixes accepted; integrated |
| 3.2 | Second opinion attachments | 3 | Closed | lane 3 | Codex review, 5 fixes accepted; integrated |
| 3.3 | Answer notice and Bring back | 3 | Closed | lane 3 | Codex review, 5 fixes accepted; integrated |
| 4.1 | One handoff builder and on-demand handoff text | 4 | In progress | lane 4 | |
| 4.2 | Hand off and Take over from actions | 4 | In progress | lane 4 | |
| 4.3 | Out-of-tokens hint | 4 | In progress | lane 4 | |
| 5.1 | Agent message store | 5 | In progress | lane 5A | |
| 5.2 | Agent messaging setting | 5 | In progress | lane 5A | |
| 5.3 | Agent directory tool | 5 | In progress | lane 5A | |
| 5.4 | Sending with identity and scope | 5 | Open | | |
| 5.5 | Delivery and status tracking | 5 | Open | | |
| 5.6 | Reply, correlation and status tool | 5 | Open | | |
| 5.7 | Envelope and literal delivery | 5 | In progress | lane 5A | |
| 6.1 | Runtime-mode ceiling and the claim gate | 6 | Open | | |
| 6.2 | No user authority | 6 | Open | | |
| 6.3 | Idempotent sends | 6 | Open | | |
| 6.4 | Ordering and turning messaging off | 6 | Open | | |
| 6.5 | Hop limit for chat senders | 6 | Open | | |
| 6.6 | Rate and backlog limits | 6 | Open | | |
| 6.7 | Held, failed, restart and cancel | 6 | Open | | |
| 7.1 | Agent sender chip | 7 | Open | | |
| 7.2 | Activity log and profiler redaction | 7 | Open | | |
| 7.3 | Settings control | 7 | Open | | |
| 8.1 | Terminal generation credential | 8 | Open | | |
| 8.2 | The bibcode agent command | 8 | Open | | |
| 8.3 | Ready for a prompt | 8 | Open | | |
| 8.4 | Pointer delivery | 8 | Open | | |
| 8.5 | Terminals in the directory | 8 | Open | | |
| 8.6 | Terminal inbox | 8 | Open | | |
| 9.1 | An AI Terminal as the source | 9 | Open | | |
| 9.2 | A terminal agent as the target | 9 | Open | | |
| 9.3 | Takeover into a terminal and terminal-side notices | 9 | Open | | |
| 10.1 | Claude conversation reader | 10 | Open | | |
| 10.2 | Codex conversation reader | 10 | Open | | |
| 11.1 | Living documentation | 11 | Open | | |
| 11.2 | Runbooks and scripted end-to-end | 11 | Open | | |
| 11.3 | Real-provider run and final gates | 11 | Open | | |

## Log
- 2026-11-13 Plan written and reviewed twice by Codex; see reviews/.
- 2026-11-13 Plan written. `rust-best-practices` installed at user level for Claude Code; it loads in a new session.
- 2026-11-13 21:55 Executor set to mstack-codex-review-workflow on branch claude/bibcode-inter-agent-communication-1bc0ff. Reviewer: Codex gpt-6-astra, high.
- 2026-11-13 21:55 1.1, 1.4, 1.2 In progress. Owner: lane 1A (opus, medium), pilot lane.
- 2026-11-13 23:10 Lane 1A reported 1.1, 1.4, 1.2 done on branch worktree-agent-a655398898037c18b (df6ef1248..92ec44d29); lib suite 5508 passed (lane report). Codex review (gpt-6-astra, high): 2 findings, both verified and accepted: person-send blockers not rechecked at admission; malformed input echoed into the refusal. Fix round goes to lane 1B.
- 2026-11-13 23:10 Ruling: fix rounds run as fresh isolated agents based on the lane branch, because a messaged lane loses its worktree. Cost if wrong: one extra agent start per fix round.
- 2026-11-13 23:10 1.3, 1.5, 1.6 In progress. Owner: lane 1B (opus, medium), based on lane 1A's branch.
- 2026-11-14 01:50 Lane 1B reported the two fixes and 1.3, 1.5, 1.6 on branch worktree-agent-a8fa0454192ccb706 (20056c4b0..efff18d8f); lib suite 5555 passed (lane report); three open questions. Codex review running.
- 2026-11-14 01:50 2.1 to 2.4 In progress. Owner: lane 2 (sonnet, medium), based on lane 1B's branch, started before phase 1's review closed because it touches no server file.
- 2026-11-14 01:58 Codex review of lane 1B (gpt-6-astra, high): 2 findings accepted (a request can finalize before its answer is complete; a new queued request is not published to subscribers), 1 coverage point accepted (restart test), 1 rejected (force both outcomes of the claim race: the loser side has a deterministic test). No cancel-and-deliver race and no agent bypass found. Fix round: lane 1C (opus, medium).
- 2026-11-14 01:58 Ruling: a cancel after the delivery is sending returns cancelled false although the row still shows queued until the turn starts, because a sent delivery cannot be withdrawn. Cost if wrong: a short window where Cancel reports too late.
- 2026-11-14 01:58 Ruling: engine Cancel also withdraws a pending delivery whose message carries personSend (needed by the cancel invariant of 1.6). Task 11.1 owes the one-line update in rpc-and-orchestration.md. Cost if wrong: a person could withdraw a pending person request through the public resolve command, which they may already do through sendRequests.cancel.
- 2026-11-14 02:25 Lane 2 reported 2.1 to 2.4 on branch worktree-agent-a2786c94f187a55d1 (6578809b6..0cf299213); checkpoint 240 tests passed (lane report). Codex review (gpt-6-astra, high): 4 findings; 3 accepted (a stale send completion clears a newer draft; string comparison of variable-precision timestamps; the closed control stays subscribed to messages and the agent list), 1 rejected (hide the control on an unsupported server: task 2.1 and UI.md ask for a disabled control that says why). Fix round: lane 2R (sonnet, medium).
- 2026-11-14 02:38 2.1, 2.2, 2.3, 2.4 Closed. Evidence: lane 2R fixed the 3 accepted findings with a failing test first for each; from apps/web the phase checkpoint plus ChatView.test.tsx gave 10 files, 420 tests passed; client-runtime sendRequests 12 passed; vp check --no-fmt, vp check on changed files and vp run typecheck exit 0 (lane report; fix diff read by the coordinator). Commits: 6578809b6..d1104d4a1 on branch worktree-agent-a2389b1ddd118699a, not integrated yet.
- 2026-11-14 02:38 3.1, 3.2, 3.3 In progress. Owner: lane 3 (sonnet, medium), based on lane 2R's branch.
- 2026-11-14 02:50 1.1, 1.2, 1.3, 1.4, 1.5, 1.6 Closed. Evidence: lane 1C fixed the 3 accepted points with failing tests first; cargo test -p bibcode-server --lib -j 2 gave 5558 passed, 0 failed; -- send_requests 80 passed five times; --test orchestration 24 passed; cargo fmt --all --check and clippy -D warnings exit 0 (lane report). Commits: df6ef1248..72f55e3ef, fast-forwarded into the Branch line's branch.
- 2026-11-14 02:50 Follow-up (outside phase 1's files): a Cursor chunk that arrives after turn.completed gets no turn id (provider/cursor/runtime.rs clears active_turn_id first), so it never joins the answer; and mcp/wait.rs treats a completed turn as settled while its message still streams. Both to be fixed in this run in a later lane.
- 2026-11-14 02:55 Phase 2's lane branch merged into the Branch line's branch (23f6a4272). 5.1, 5.2, 5.3, 5.7 In progress. Owner: lane 5A (opus, medium).
- 2026-11-14 03:05 Lane 3 reported 3.1 to 3.3 on branch worktree-agent-ab4028d8cc1c0678c (193aa3612..a115914ed); checkpoint 158 tests passed (lane report). Codex review (gpt-6-astra, high): 5 findings, all accepted (a second panel after a lost creation response; the source preview unmounts when the new panel activates; a hidden notice marked opened; opened ids pruned by a first-page snapshot; a late completion changes the scope a reopened preview sends). Fix round: lane 3R (sonnet, medium).
- 2026-11-14 03:20 3.1, 3.2, 3.3 Closed. Evidence: lane 3R fixed the 5 accepted findings, each failing test committed before its fix; the coordinator ran in the lane worktree from apps/web: vp test run --project unit src/components/sendToAgent src/centerPanelStore.test.ts src/centerPanelActions.test.ts src/components/CenterPanel: 19 files, 279 tests passed; vp check --no-fmt: no warnings or lint errors in 2471 files; vp fmt --check on the 16 changed files: correct. Commits: 193aa3612..525225670, merged into the Branch line's branch.
- 2026-11-14 03:20 Ruling: lane 3R edited centerPanelStore.ts, CenterPanelSurfaceHosts.tsx and added centerSurfaceVisibility.ts (outside phase 3's Owns), because a review panel must be reserved inactive and a notice must know whether its surface is visible. Cost if wrong: two small optional parameters to revert.
- 2026-11-14 03:20 4.1, 4.2, 4.3 In progress. Owner: lane 4 (opus, medium), started while phase 5 runs; both touch production/provider_runtime.rs in different regions, merged by the coordinator.
