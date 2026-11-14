# Progress: Send to agent and agent messaging

Plan: plan.md
Spec: spec.md (sha256 d3eed2efe3ec)
Plan status: Approved 2026-11-13
Plan review: Codex gpt-6-astra (high), round 2, Needs rework; findings handled, fixes after round 2 not reviewed again
Executor: mstack-codex-review-workflow
Branch: claude/bibcode-inter-agent-communication-1bc0ff

| Task | Title | Phase | State | Owner | Note |
|---|---|---|---|---|---|
| 1.1 | Send request record and store | 1 | Open | | |
| 1.2 | Person-only send operation | 1 | Open | | |
| 1.3 | Request states from turn events | 1 | Open | | |
| 1.4 | Contracts for send requests | 1 | Open | | |
| 1.5 | Retry and replay of a person's send | 1 | Open | | |
| 1.6 | Cancel, dismiss, subscribe and answer retrieval | 1 | Open | | |
| 2.1 | Control, menu and agent list | 2 | Open | | |
| 2.2 | Preview and Message send | 2 | Open | | |
| 2.3 | Person-send label in the transcript | 2 | Open | | |
| 2.4 | Request state row | 2 | Open | | |
| 3.1 | Review action | 3 | Open | | |
| 3.2 | Second opinion attachments | 3 | Open | | |
| 3.3 | Answer notice and Bring back | 3 | Open | | |
| 4.1 | One handoff builder and on-demand handoff text | 4 | Open | | |
| 4.2 | Hand off and Take over from actions | 4 | Open | | |
| 4.3 | Out-of-tokens hint | 4 | Open | | |
| 5.1 | Agent message store | 5 | Open | | |
| 5.2 | Agent messaging setting | 5 | Open | | |
| 5.3 | Agent directory tool | 5 | Open | | |
| 5.4 | Sending with identity and scope | 5 | Open | | |
| 5.5 | Delivery and status tracking | 5 | Open | | |
| 5.6 | Reply, correlation and status tool | 5 | Open | | |
| 5.7 | Envelope and literal delivery | 5 | Open | | |
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
