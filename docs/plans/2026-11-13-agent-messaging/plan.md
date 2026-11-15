# Send to agent and agent messaging

Status: Approved 2026-11-13 (approved in chat by the user)
Spec: spec.md (Status line: both parts Approved 2026-11-13, sha256 d3eed2efe3ec)
Repository: this repository
Base: main

`spec.md` joins two approved specifications. Part A is the agent messaging design
(R1 to R21, D0 to D12). Part B is the Send to agent design, renumbered R101 to R119 and
D101 to D117. The two source files beside this folder are the binding text.

## Goal

1. From a chat panel or an AI Terminal, a person sends a review request, a second opinion,
   a handoff, a takeover or a message to an agent they pick, with the context attached, and
   gets the answer back as a notice (Part B goals 1 to 5).
2. An agent in one chat thread or AI Terminal sends a message to another agent of the same
   project and receives the reply in its own context, with no person relaying text
   (Part A goals 1 and 2).
3. Every message and request has a state its sender can read, never carries a person's
   authority when an agent wrote it, never leaves its project, and a runaway exchange stops
   on its own (Part A goals 3 to 5).

## Global constraints

Values from the spec. Every task obeys them without repeating them.

- Agent address: `thread:<threadId>` for a chat agent, `terminal:<threadId>/<terminalId>`
  for a terminal agent (Part A Vocabulary).
- Agent message text limit 16,000 characters (R2). Person request limit 48,000 characters
  for note plus attachments (Part B Constraints, amendment to R2).
- Hop limit 8 (R14). Rate limit 30 agent messages per sender per 60 seconds; backlog limit
  20 unconsumed agent messages per recipient (R15).
- Agent message states: `accepted`, `queued`, `held`, `delivered`, `consumed`,
  `completed`, `cancelled`, `failed` (R11). Reasons used by the spec: `messaging_off`,
  `recipient_mode_above_sender`, `recipient_gone`, `recipient_turn_failed`.
- Send request states shown to the person: queued, waiting, delivered, read, answered, not
  answered, cancelled (R119).
- Runtime-mode order: `approval-required` < `auto-accept-edits` < `full-access` (R6). A
  terminal agent sends with its thread's mode and receives as `full-access`.
- Agent tools (D12): `agents_list`, `agent_message_send`, `agent_message_reply`,
  `agent_message_status`, `agent_message_cancel`; terminal command `bibcode agent` with
  `list`, `send`, `reply`, `status`, `cancel`, `inbox`.
- Second opinion cuts each attached text at 16,000 characters (R108). Handoff text is the
  first message from the person cut at 4,000 characters, then the most recent 40 messages
  within 24,000 characters (R109). Terminal output attachment is at most 16,000 characters
  (R110, R111).
- Agent messaging is off by default and scoped to one project in one environment (R4, R5).
  A person's send works while it is off (R113).
- Agent messages never steer or interrupt a running turn (Part A Non-goals).
- Nothing is ever typed into a terminal except the fixed pointer line (R17, R111).
- No message, note or attachment text in profiler events, findings or logs (R21, AGENTS.md).
- Public repository rules: placeholders only for hosts, names and paths; the identity guard
  bans the predecessor project's short name as a token (`scripts/bibcode-identity.test.ts`).
- Interface copy follows `UI.md`: verb labels, reasons on disabled entries, no em dashes.

Names fixed by this plan, so that tasks agree (agent's calls, see P3):

| Thing                                 | Name                                                                                                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server module, person requests        | `apps/server/src/send_requests/` (`mod.rs`, `store.rs`, `service.rs`)                                                                                                                   |
| Server module, agent messages         | `apps/server/src/agent_messaging/` (`mod.rs`, `store.rs`, `policy.rs`, `envelope.rs`, `delivery.rs`, `directory.rs`, `pointer.rs`, `terminal_credential.rs`)                            |
| Server module, handoff text           | `apps/server/src/production/thread_context.rs`                                                                                                                                          |
| Tables                                | `send_requests` (migration 75), `agent_messages` (migration 76)                                                                                                                         |
| RPC methods (signed-in person only)   | `sendRequests.send`, `sendRequests.cancel`, `sendRequests.dismiss`, `sendRequests.subscribe`, `sendRequests.getAnswer`, `sendRequests.getHandoffText`, `sendRequests.getTerminalOutput` |
| Message provenance of a person's send | `message.personSend = { requestId, action, sourceAddress }`                                                                                                                             |
| Actor of an agent message             | `{ kind: "hosted-agent", address, label }`                                                                                                                                              |
| Setting                               | `agentMessaging.enabled` (boolean, default false)                                                                                                                                       |
| Terminal credential environment       | `BIBCODE_AGENT_AUTH`, `BIBCODE_AGENT_ENDPOINT`                                                                                                                                          |
| Web folder                            | `apps/web/src/components/sendToAgent/` and `apps/web/src/sendToAgentStore.ts`                                                                                                           |
| Action ids                            | `review`, `second-opinion`, `hand-off`, `take-over`, `message`                                                                                                                          |

## Review focus

1. An agent or outside MCP client reaches the person-only send path and skips the
   messaging safeguards. Pinned by task 1.2.
2. Envelope forgery and text that a provider would run as a command or expand as a file.
   Pinned by task 5.7.
3. The pointer line lands in a pending question or in a shell after the CLI exited. Pinned
   by tasks 8.3 and 8.4.
4. A crash between storing a message and queueing it, or a restart with queued messages.
   Pinned by tasks 5.1 and 6.7.
5. A CLI conversation path that points outside the provider's folder or at another
   session. Pinned by task 10.1.

## Out of scope

- Broadcast and group addresses: one sender and one recipient keep authorization simple.
- Automatic delegation, starting threads or terminals for another agent, worker supervision.
- Messaging across projects or environments.
- Steering or interrupting a running turn with an agent message.
- Changing what an outside agent (`mcp-client`) can do.
- Typing a message body into a terminal.
- Provider-native messaging between sessions.
- Replacing the Source Control panel's Code review button.
- An `@agent` shortcut typed in the composer.
- A model-written summary of a thread.
- Stopping, archiving or changing the mode of any agent as a side effect of a send.

## Sources

- Repository rules: `AGENTS.md` (pre-work, architecture and completion rules, profiler
  coverage, sensitive data, runbook maintenance), `UI.md` (every user-facing change),
  `docs/skills/issue-delivery/SKILL.md` (acceptance criterion and proof before validation).
- Repository docs:
  - `docs/reference/mcp.md` (tools, access, limits, errors; the drift test reads it)
  - `docs/architecture/rpc-and-orchestration.md` (turn queue, promotion gate, hold rule,
    actor attribution, terminal tools)
  - `docs/architecture/providers.md` (MCP injection per provider, context handoff, terminal
    environment)
  - `docs/architecture/activity-observation.md` (terminal agent status, observers)
  - `docs/architecture/runtime-modes.md` (mode values and provider mappings)
  - `docs/user/workspace-ui.md`, `docs/user/mcp.md` (user documentation to update)
  - `docs/testing/README.md`, `docs/testing/cross-platform-validation.md` (commands, runbooks)
  - `docs/plans/2026-11-11-code-review-button-design.md` (the review launcher this reuses)
- Code map, verified at `a9938193b`:
  - Provider tool registration `ToolSpec::provider` in `apps/server/src/mcp/control.rs`,
    list in `apps/server/src/mcp/tools/previews.rs`, `tools/call` for providers in
    `apps/server/src/production/connect_mcp.rs` (`authorize_call`, `PreviewScope`)
  - Turn queue: `apps/server/src/production/turn_delivery.rs`, table `provider_turn_outbox`,
    tests in `apps/server/src/production/turn_delivery_queue_tests.rs`
  - Source-thread rule: `apps/server/src/orchestration/engine.rs` (the `source_thread_id`
    check under the comment "Provenance (#139, slice X4)")
  - Actor stamping: `apps/server/src/production/orchestration_rpc.rs`
  - Handoff text: `thread_context_lines` and `compose_thread_context_handoff` in
    `apps/server/src/production/provider_runtime.rs`
  - Terminal environment hook and open-URL credential: `apps/server/src/open_url.rs`,
    `issue_open_url_credential` in `apps/server/src/production/connect_mcp.rs`,
    `session_env_hook` in `apps/server/src/terminal/manager.rs`
  - Terminal agent state: `TerminalAgentState` in `apps/server/src/provider_terminal/model.rs`
  - CLI: `CliCommand` in `apps/server/src/config.rs`, `apps/server/src/mcp/thread_cli.rs`,
    `apps/server/src/mcp/relay.rs`
  - Migrations: `apps/server/src/persistence/migrations.rs` (latest is 74)
  - RPC table: `apps/server/src/rpc/methods.rs`, handlers `apps/server/src/rpc/session.rs`,
    `packages/contracts/src/rpc.ts`, parity test `packages/contracts/src/rpcRustParity.test.ts`
  - Composer footer: `apps/web/src/components/chat/ChatComposer.tsx`,
    `ComposerPrimaryActions.tsx`; terminal toolbar and selection:
    `apps/web/src/components/ThreadTerminalPanel.tsx`
  - Review launcher: `apps/web/src/codeReview.ts`, `handleStartCodeReview` in
    `apps/web/src/components/ChatView.tsx`; Bring back: `apps/web/src/sideChatBringBack.ts`
  - Provenance display: `apps/web/src/components/chat/MessageProvenance.tsx`,
    `AgentActorChip.tsx`; unread: `apps/web/src/uiStateStore.ts`
  - Settings: `packages/contracts/src/settings.ts`, `apps/server/src/production/control.rs`,
    `apps/web/src/components/settings/AgentIntegrationsSection.tsx`
- External: none. Research behind the specs is summarized in the specs' Evidence sections.

## Stack and commands

Run from the repository root. Sources: `AGENTS.md`, `docs/testing/README.md`,
`.github/workflows/ci.yml`, package manifests. Not run during planning: dependencies are
not installed in the planning worktree.

| Layer       | Stack                     | Commands                                                                                                                                             |
| ----------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server      | Rust, Axum, Tokio, SQLite | `cargo test -p bibcode-server --lib -j 2 -- <name_filter>`; `cargo fmt --all --check`; `cargo clippy -p bibcode-server --all-targets -- -D warnings` |
| Contracts   | TypeScript, effect/Schema | `vp test run packages/contracts/src/<file>.test.ts`; `vp run check:contracts` (regenerates fixtures; commit them)                                    |
| Web         | React, Vite               | from `apps/web`: `vp test run --project unit src/<path>.test.tsx`                                                                                    |
| Workspace   | Vite+                     | `vp check`; `vp run typecheck`                                                                                                                       |
| Desktop E2E | WebdriverIO               | `vp run test:ui:desktop:build`, then `vp run test:ui:desktop`                                                                                        |
| Guards      | scripts                   | `vp test run scripts/bibcode-identity.test.ts`; `vp test run scripts/no-sensitive-data.test.ts`; `vp run check:markdown-links`                       |

Use `node scripts/run-local-vp.mjs <args>` where a global `vp` shadows the workspace copy.
Use a rustup-pinned `cargo`, not a Homebrew one.

## Phases

| Phase | File                                       | Goal                                                     | Round | Depends on    | Tier         |
| ----- | ------------------------------------------ | -------------------------------------------------------- | ----- | ------------- | ------------ |
| 1     | phases/PHASE-01-person-send-core.md        | Request record, person-only send, request states         | 1     | none          | most capable |
| 2     | phases/PHASE-02-send-to-agent-ui.md        | Control, menu, preview, Message, attribution, state row  | 2     | 1             | standard     |
| 3     | phases/PHASE-03-review-second-opinion.md   | Review, Second opinion, answer notice                    | 3     | 1, 2          | standard     |
| 4     | phases/PHASE-04-handoff-takeover.md        | Handoff builder on demand, Hand off, Take over, hint     | 4     | 1, 2, 3       | standard     |
| 5     | phases/PHASE-05-agent-messaging-core.md    | Store, setting, agent tools, envelope, delivery, reply   | 3     | 1, 2          | most capable |
| 6     | phases/PHASE-06-messaging-safety.md        | Ceiling, authority, idempotency, order, limits, recovery | 4     | 5             | most capable |
| 7     | phases/PHASE-07-messaging-visibility.md    | Agent sender chip, activity log, settings control        | 5     | 5, 6          | standard     |
| 8     | phases/PHASE-08-terminal-foundation.md     | Terminal credential, command, readiness, pointer, inbox  | 6     | 5, 6, 7       | most capable |
| 9     | phases/PHASE-09-terminals-send-to-agent.md | Terminal as source and as target of a person's send      | 7     | 1, 2, 3, 4, 8 | standard     |
| 10    | phases/PHASE-10-cli-conversation.md        | Read a CLI's own conversation, safely                    | 8     | 8, 9          | most capable |
| 11    | phases/PHASE-11-docs-e2e.md                | Living docs, runbooks, end-to-end proof                  | 9     | 3, 5, 9, 10   | standard     |

Phases in the same round run in parallel. A phase depends only on phases in earlier rounds.

## File map

Generated from the Files lines of every task. The owning phase is the first phase that names the
path; a later phase that names it again extends it and never shares a round with the owner.
Migration 75 (`send_requests`) belongs to task 1.1 and migration 76 (`agent_messages`) to task 5.1.

| Path or external change                                                                   | Action | Phase | Verification        |
| ----------------------------------------------------------------------------------------- | ------ | ----- | ------------------- |
| `apps/server/src/auth/scope.rs` (extended by phase 4, 9)                                  | modify | 1     | phase 1 checkpoint  |
| `apps/server/src/lib.rs` (extended by phase 5, 8)                                         | modify | 1     | phase 1 checkpoint  |
| `apps/server/src/lifecycle.rs` (extended by phase 5, 8)                                   | modify | 1     | phase 1 checkpoint  |
| `apps/server/src/orchestration/engine.rs` (extended by phase 5, 6)                        | modify | 1     | phase 1 checkpoint  |
| `apps/server/src/persistence/migrations.rs` (extended by phase 5)                         | modify | 1     | phase 1 checkpoint  |
| `apps/server/src/persistence/repositories.rs` (extended by phase 5, 6, 7)                 | modify | 1     | phase 1 checkpoint  |
| `apps/server/src/production/connect_mcp/tests.rs` (extended by phase 5, 7)                | modify | 1     | phase 1 checkpoint  |
| `apps/server/src/production/mcp_tools_tests/mod.rs` (extended by phase 5, 6)              | modify | 1     | phase 1 checkpoint  |
| `apps/server/src/production/mcp_tools_tests/send_requests.rs`                             | create | 1     | phase 1 checkpoint  |
| `apps/server/src/production/orchestration_rpc.rs` (extended by phase 5, 6)                | modify | 1     | phase 1 checkpoint  |
| `apps/server/src/production/provider_runtime.rs` (extended by phase 4, 5)                 | modify | 1     | phase 1 checkpoint  |
| `apps/server/src/production/runtime.rs` (extended by phase 5, 6, 7, 8, 9)                 | modify | 1     | phase 1 checkpoint  |
| `apps/server/src/rpc/methods.rs` (extended by phase 4, 9)                                 | modify | 1     | phase 1 checkpoint  |
| `apps/server/src/send_requests/mod.rs` (extended by phase 9)                              | create | 1     | phase 1 checkpoint  |
| `apps/server/src/send_requests/rpc.rs` (extended by phase 4)                              | create | 1     | phase 1 checkpoint  |
| `apps/server/src/send_requests/service.rs` (extended by phase 4, 9, 10)                   | create | 1     | phase 1 checkpoint  |
| `apps/server/src/send_requests/store.rs`                                                  | create | 1     | phase 1 checkpoint  |
| `apps/server/src/send_requests/tests.rs` (extended by phase 4)                            | create | 1     | phase 1 checkpoint  |
| `apps/server/tests/production_provider_runtime.rs`                                        | modify | 1     | phase 1 checkpoint  |
| `apps/server/tests/repositories.rs`                                                       | modify | 1     | phase 1 checkpoint  |
| `apps/server/tests/support/load_fixture.rs`                                               | modify | 1     | phase 1 checkpoint  |
| `packages/client-runtime/src/state/threadReducer.test.ts` (extended by phase 5)           | modify | 1     | phase 1 checkpoint  |
| `packages/client-runtime/src/state/threadReducer.ts` (extended by phase 5)                | modify | 1     | phase 1 checkpoint  |
| `packages/contracts/fixtures/**` (extended by phase 4)                                    | modify | 1     | phase 1 checkpoint  |
| `packages/contracts/src/environment.test.ts` (extended by phase 5)                        | modify | 1     | phase 1 checkpoint  |
| `packages/contracts/src/environment.ts` (extended by phase 5)                             | modify | 1     | phase 1 checkpoint  |
| `packages/contracts/src/index.ts` (extended by phase 5)                                   | modify | 1     | phase 1 checkpoint  |
| `packages/contracts/src/orchestration.test.ts` (extended by phase 5)                      | modify | 1     | phase 1 checkpoint  |
| `packages/contracts/src/orchestration.ts` (extended by phase 5)                           | modify | 1     | phase 1 checkpoint  |
| `packages/contracts/src/rpc.ts` (extended by phase 4, 9)                                  | modify | 1     | phase 1 checkpoint  |
| `packages/contracts/src/sendRequests.test.ts` (extended by phase 9)                       | create | 1     | phase 1 checkpoint  |
| `packages/contracts/src/sendRequests.ts` (extended by phase 9)                            | create | 1     | phase 1 checkpoint  |
| `packages/shared/src/testSupport.ts` (extended by phase 5)                                | modify | 1     | phase 1 checkpoint  |
| `apps/web/src/components/chat/ChatComposer.test.tsx`                                      | modify | 2     | phase 2 checkpoint  |
| `apps/web/src/components/chat/ChatComposer.tsx`                                           | modify | 2     | phase 2 checkpoint  |
| `apps/web/src/components/chat/MessageProvenance.test.tsx` (extended by phase 7)           | modify | 2     | phase 2 checkpoint  |
| `apps/web/src/components/chat/MessageProvenance.tsx` (extended by phase 5, 7)             | modify | 2     | phase 2 checkpoint  |
| `apps/web/src/components/chat/MessagesTimeline.test.tsx`                                  | modify | 2     | phase 2 checkpoint  |
| `apps/web/src/components/chat/MessagesTimeline.tsx`                                       | modify | 2     | phase 2 checkpoint  |
| `apps/web/src/components/ChatView.tsx` (extended by phase 3, 4, 9)                        | modify | 2     | phase 2 checkpoint  |
| `apps/web/src/components/sendToAgent/SendRequestRow.test.tsx`                             | create | 2     | phase 2 checkpoint  |
| `apps/web/src/components/sendToAgent/SendRequestRow.tsx`                                  | create | 2     | phase 2 checkpoint  |
| `apps/web/src/components/sendToAgent/sendToAgent.logic.test.ts` (extended by phase 4)     | create | 2     | phase 2 checkpoint  |
| `apps/web/src/components/sendToAgent/sendToAgent.logic.ts` (extended by phase 4, 9)       | create | 2     | phase 2 checkpoint  |
| `apps/web/src/components/sendToAgent/SendToAgentButton.test.tsx` (extended by phase 3, 4) | create | 2     | phase 2 checkpoint  |
| `apps/web/src/components/sendToAgent/SendToAgentButton.tsx` (extended by phase 4)         | create | 2     | phase 2 checkpoint  |
| `apps/web/src/components/sendToAgent/SendToAgentPreview.test.tsx` (extended by phase 4)   | create | 2     | phase 2 checkpoint  |
| `apps/web/src/components/sendToAgent/SendToAgentPreview.tsx` (extended by phase 4)        | create | 2     | phase 2 checkpoint  |
| `apps/web/src/sendToAgentStore.test.ts`                                                   | create | 2     | phase 2 checkpoint  |
| `apps/web/src/sendToAgentStore.ts`                                                        | create | 2     | phase 2 checkpoint  |
| `apps/web/src/state/sendRequests.test.ts`                                                 | create | 2     | phase 2 checkpoint  |
| `apps/web/src/state/sendRequests.ts` (extended by phase 4)                                | create | 2     | phase 2 checkpoint  |
| `packages/client-runtime/package.json`                                                    | modify | 2     | phase 2 checkpoint  |
| `packages/client-runtime/src/state/sendRequests.test.ts`                                  | create | 2     | phase 2 checkpoint  |
| `packages/client-runtime/src/state/sendRequests.ts` (extended by phase 4, 9)              | create | 2     | phase 2 checkpoint  |
| `apps/web/src/centerPanelActions.test.ts`                                                 | modify | 3     | phase 3 checkpoint  |
| `apps/web/src/centerPanelActions.ts`                                                      | modify | 3     | phase 3 checkpoint  |
| `apps/web/src/components/sendToAgent/AnswerNotice.test.tsx`                               | create | 3     | phase 3 checkpoint  |
| `apps/web/src/components/sendToAgent/AnswerNotice.tsx`                                    | create | 3     | phase 3 checkpoint  |
| `apps/web/src/components/sendToAgent/attachments.logic.test.ts`                           | create | 3     | phase 3 checkpoint  |
| `apps/web/src/components/sendToAgent/attachments.logic.ts`                                | create | 3     | phase 3 checkpoint  |
| `apps/web/src/components/sendToAgent/review.logic.test.ts`                                | create | 3     | phase 3 checkpoint  |
| `apps/web/src/components/sendToAgent/review.logic.ts`                                     | create | 3     | phase 3 checkpoint  |
| `apps/web/src/components/sendToAgent/ReviewScopePicker.test.tsx`                          | create | 3     | phase 3 checkpoint  |
| `apps/web/src/components/sendToAgent/ReviewScopePicker.tsx`                               | create | 3     | phase 3 checkpoint  |
| `apps/web/src/components/sendToAgent/SendRequestsUnreadTracker.test.tsx`                  | create | 3     | phase 3 checkpoint  |
| `apps/web/src/components/sendToAgent/SendRequestsUnreadTracker.tsx`                       | create | 3     | phase 3 checkpoint  |
| `apps/web/src/components/Sidebar.tsx`                                                     | modify | 3     | phase 3 checkpoint  |
| `apps/web/src/sendRequestOpenedStore.test.ts`                                             | create | 3     | phase 3 checkpoint  |
| `apps/web/src/sendRequestOpenedStore.ts`                                                  | create | 3     | phase 3 checkpoint  |
| `apps/web/src/sideChatBringBack.test.ts`                                                  | modify | 3     | phase 3 checkpoint  |
| `apps/web/src/sideChatBringBack.ts`                                                       | modify | 3     | phase 3 checkpoint  |
| `apps/server/src/production/mod.rs`                                                       | modify | 4     | phase 4 checkpoint  |
| `apps/server/src/production/thread_context.rs` (extended by phase 10)                     | create | 4     | phase 4 checkpoint  |
| `apps/web/src/components/sendToAgent/handoff.logic.test.ts`                               | create | 4     | phase 4 checkpoint  |
| `apps/web/src/components/sendToAgent/handoff.logic.ts`                                    | create | 4     | phase 4 checkpoint  |
| `apps/web/src/components/sendToAgent/outOfTokens.logic.test.ts`                           | create | 4     | phase 4 checkpoint  |
| `apps/web/src/components/sendToAgent/outOfTokens.logic.ts`                                | create | 4     | phase 4 checkpoint  |
| `apps/server/src/agent_messaging/delivery.rs` (extended by phase 6)                       | create | 5     | phase 5 checkpoint  |
| `apps/server/src/agent_messaging/directory.rs` (extended by phase 8)                      | create | 5     | phase 5 checkpoint  |
| `apps/server/src/agent_messaging/envelope.rs`                                             | create | 5     | phase 5 checkpoint  |
| `apps/server/src/agent_messaging/mod.rs` (extended by phase 6, 8, 9)                      | create | 5     | phase 5 checkpoint  |
| `apps/server/src/agent_messaging/store.rs` (extended by phase 8, 9)                       | create | 5     | phase 5 checkpoint  |
| `apps/server/src/mcp/activity.rs` (extended by phase 7)                                   | modify | 5     | phase 5 checkpoint  |
| `apps/server/src/mcp/control.rs`                                                          | modify | 5     | phase 5 checkpoint  |
| `apps/server/src/mcp/tools/agent_messaging.rs` (extended by phase 6, 8)                   | create | 5     | phase 5 checkpoint  |
| `apps/server/src/mcp/tools/mod.rs`                                                        | modify | 5     | phase 5 checkpoint  |
| `apps/server/src/orchestration/delivery.rs` (extended by phase 6)                         | modify | 5     | phase 5 checkpoint  |
| `apps/server/src/production/connect_mcp.rs`                                               | modify | 5     | phase 5 checkpoint  |
| `apps/server/src/production/control.rs`                                                   | modify | 5     | phase 5 checkpoint  |
| `apps/server/src/production/mcp_tools_tests/agent_messaging.rs` (extended by phase 6, 8)  | create | 5     | phase 5 checkpoint  |
| `apps/server/src/production/turn_delivery_queue_tests.rs`                                 | modify | 5     | phase 5 checkpoint  |
| `packages/contracts/src/agentMessaging.test.ts`                                           | create | 5     | phase 5 checkpoint  |
| `packages/contracts/src/agentMessaging.ts`                                                | create | 5     | phase 5 checkpoint  |
| `packages/contracts/src/settings.test.ts`                                                 | modify | 5     | phase 5 checkpoint  |
| `packages/contracts/src/settings.ts`                                                      | modify | 5     | phase 5 checkpoint  |
| `apps/server/src/agent_messaging/policy.rs`                                               | create | 6     | phase 6 checkpoint  |
| `apps/server/src/production/mcp_tools_tests/feed.rs`                                      | modify | 7     | phase 7 checkpoint  |
| `apps/web/src/components/chat/AgentActorChip.test.tsx`                                    | modify | 7     | phase 7 checkpoint  |
| `apps/web/src/components/chat/AgentActorChip.tsx`                                         | modify | 7     | phase 7 checkpoint  |
| `apps/web/src/components/settings/AgentIntegrationsSection.test.tsx`                      | modify | 7     | phase 7 checkpoint  |
| `apps/web/src/components/settings/AgentIntegrationsSection.tsx`                           | modify | 7     | phase 7 checkpoint  |
| `apps/web/src/components/settings/McpAgentsPanel.test.tsx`                                | modify | 7     | phase 7 checkpoint  |
| `apps/web/src/components/settings/McpAgentsPanel.tsx`                                     | modify | 7     | phase 7 checkpoint  |
| `packages/contracts/src/mcpActivity.test.ts`                                              | create | 7     | phase 7 checkpoint  |
| `packages/contracts/src/mcpActivity.ts`                                                   | modify | 7     | phase 7 checkpoint  |
| `apps/server/src/agent_messaging/pointer.rs` (extended by phase 9)                        | create | 8     | phase 8 checkpoint  |
| `apps/server/src/agent_messaging/terminal_credential.rs`                                  | create | 8     | phase 8 checkpoint  |
| `apps/server/src/config.rs`                                                               | modify | 8     | phase 8 checkpoint  |
| `apps/server/src/diagnostics/profiler/cli.rs`                                             | modify | 8     | phase 8 checkpoint  |
| `apps/server/src/http.rs`                                                                 | modify | 8     | phase 8 checkpoint  |
| `apps/server/src/mcp/agent_cli.rs`                                                        | create | 8     | phase 8 checkpoint  |
| `apps/server/src/mcp/agent_cli/tests.rs`                                                  | create | 8     | phase 8 checkpoint  |
| `apps/server/src/mcp/mod.rs`                                                              | modify | 8     | phase 8 checkpoint  |
| `apps/server/src/mcp/thread_cli.rs`                                                       | modify | 8     | phase 8 checkpoint  |
| `apps/server/src/production/http_routes.rs`                                               | modify | 8     | phase 8 checkpoint  |
| `apps/server/src/provider_terminal/agent_status_tests.rs`                                 | modify | 8     | phase 8 checkpoint  |
| `apps/server/src/provider_terminal/codex.rs` (extended by phase 10)                       | modify | 8     | phase 8 checkpoint  |
| `apps/server/src/provider_terminal/model.rs` (extended by phase 10)                       | modify | 8     | phase 8 checkpoint  |
| `apps/server/src/terminal/manager.rs` (extended by phase 10)                              | modify | 8     | phase 8 checkpoint  |
| `apps/server/src/terminal/mod.rs`                                                         | modify | 8     | phase 8 checkpoint  |
| `apps/server/src/terminal/model.rs`                                                       | modify | 8     | phase 8 checkpoint  |
| `packages/contracts/src/terminal.test.ts`                                                 | modify | 8     | phase 8 checkpoint  |
| `packages/contracts/src/terminal.ts`                                                      | modify | 8     | phase 8 checkpoint  |
| `apps/server/src/send_requests/terminal.rs`                                               | create | 9     | phase 9 checkpoint  |
| `apps/web/src/components/sendToAgent/TerminalSendComposer.test.tsx`                       | create | 9     | phase 9 checkpoint  |
| `apps/web/src/components/sendToAgent/TerminalSendComposer.tsx` (extended by phase 10)     | create | 9     | phase 9 checkpoint  |
| `apps/web/src/components/ThreadTerminalPanel.test.tsx`                                    | modify | 9     | phase 9 checkpoint  |
| `apps/web/src/components/ThreadTerminalPanel.tsx`                                         | modify | 9     | phase 9 checkpoint  |
| `apps/server/src/agent_sessions/mod.rs`                                                   | modify | 10    | phase 10 checkpoint |
| `apps/server/src/diagnostics/profiler/latency.rs`                                         | modify | 10    | phase 10 checkpoint |
| `apps/server/src/provider_terminal/claude.rs`                                             | modify | 10    | phase 10 checkpoint |
| `apps/server/src/provider_terminal/conversation.rs`                                       | create | 10    | phase 10 checkpoint |
| `apps/server/src/provider_terminal/mod.rs`                                                | modify | 10    | phase 10 checkpoint |
| `apps/server/tests/fixtures/provider-terminal/codex-turns-list.json`                      | create | 10    | phase 10 checkpoint |
| `apps/desktop/e2e/specs/send-to-agent.e2e.ts`                                             | create | 11    | phase 11 checkpoint |
| `apps/desktop/e2e/wdio.conf.ts`                                                           | modify | 11    | phase 11 checkpoint |
| `apps/server/src/mcp/reference_docs.rs`                                                   | modify | 11    | phase 11 checkpoint |
| `docs/architecture/activity-observation.md`                                               | modify | 11    | phase 11 checkpoint |
| `docs/architecture/overview.md`                                                           | modify | 11    | phase 11 checkpoint |
| `docs/architecture/providers.md`                                                          | modify | 11    | phase 11 checkpoint |
| `docs/architecture/rpc-and-orchestration.md`                                              | modify | 11    | phase 11 checkpoint |
| `docs/reference/mcp.md`                                                                   | modify | 11    | phase 11 checkpoint |
| `docs/skills/bibcode-mcp/SKILL.md`                                                        | modify | 11    | phase 11 checkpoint |
| `docs/testing/cross-platform-validation.md`                                               | modify | 11    | phase 11 checkpoint |
| `docs/testing/README.md`                                                                  | modify | 11    | phase 11 checkpoint |
| `docs/user/mcp.md`                                                                        | modify | 11    | phase 11 checkpoint |
| `docs/user/workspace-ui.md`                                                               | modify | 11    | phase 11 checkpoint |

Shared files reserved for the executor: `Cargo.lock`, `pnpm-lock.yaml`, `progress.md`,
`docs/README.md`, `docs/plans/README.md`.

Parallel conflicts:

- Round 3 (phases 3 and 5): none; no task of one names a file of the other.
- Round 4 (phases 4 and 6): none; no task of one names a file of the other.
- Contract fixtures (`packages/contracts/fixtures/`) are regenerated by tasks in phases 1, 4, 5, 8
  and 9. Phases 4 and 6 share round 4 and phase 6 changes no contract, so only one phase per round
  regenerates them.
- A file marked "extended by" is edited again by a later phase in a later round. That task names
  the file in its own Files line and adds to it; it does not rewrite the earlier work.

## Traceability

| Requirement | Tasks                               |
| ----------- | ----------------------------------- |
| R1          | 5.3, 8.5                            |
| R2          | 5.1, 5.4, 9.2                       |
| R3          | 5.4                                 |
| R4          | 5.3, 5.4                            |
| R5          | 5.2, 5.3, 6.1, 6.4, 7.3, 9.2        |
| R6          | 6.1, 6.4, 8.4, 8.2, 9.2             |
| R7          | 5.5, 11.3                           |
| R8          | 5.7, 9.2                            |
| R9          | 6.2                                 |
| R10         | 5.6, 9.2, 11.3                      |
| R11         | 5.5, 5.6, 8.2                       |
| R12         | 6.3                                 |
| R13         | 6.4                                 |
| R14         | 6.5, 8.6, 8.2, 9.2                  |
| R15         | 6.6                                 |
| R16         | 8.1, 8.2                            |
| R17         | 8.3, 8.4, 8.6, 11.3                 |
| R18         | 6.7, 8.6                            |
| R19         | 5.1, 6.7                            |
| R20         | 6.7, 8.6                            |
| R21         | 5.4, 7.1, 7.2                       |
| R101        | 2.1, 9.1                            |
| R102        | 2.1                                 |
| R103        | 2.1, 4.3, 9.3                       |
| R104        | 2.1                                 |
| R105        | 2.2                                 |
| R106        | 2.2                                 |
| R107        | 3.1                                 |
| R108        | 3.2, 9.1                            |
| R109        | 4.1, 4.2                            |
| R110        | 4.1, 4.2, 9.1, 9.3                  |
| R111        | 9.1                                 |
| R112        | 10.1, 10.2                          |
| R113        | 1.2                                 |
| R114        | 1.2, 2.3                            |
| R115        | 9.2                                 |
| R116        | 1.3, 1.6, 3.1, 3.3, 9.3, 11.2, 11.3 |
| R117        | 4.3                                 |
| R118        | 1.1, 1.2, 1.5, 2.2, 3.1             |
| R119        | 1.1, 1.3, 1.6, 2.4, 3.1, 9.2, 9.3   |

## End-to-end verification

- Scripted WebDriver run (`apps/desktop/e2e/specs/send-to-agent.e2e.ts`): a second opinion
  from one chat panel to another, the answer notice, and Bring back (Part B Goal 1).
- Server integration test with two scripted providers: A sends, B consumes and replies, A
  receives the reply envelope (Part A Goal 1).
- One real-provider run with the Profiler on: a Claude thread asks a Codex panel for a
  second opinion through the control, and a Claude agent messages a Codex agent and gets
  the reply. Profiler data is read afterwards for findings and for message text, which must
  not appear.
- `vp check`, `vp run typecheck`, `cargo fmt --all --check`,
  `cargo clippy -p bibcode-server --all-targets -- -D warnings`, the server test suite, the
  identity and sensitive-data guards, and the markdown link check all pass.

## Risks

- Parallel phases on one branch overwrite each other -> ownership per phase file, web and
  server paired in each parallel round, and the Parallel conflicts list above.
- Codex filters the environment of the commands its agent runs, so `bibcode agent` may not
  see its credential -> task 8.2 proves it inside a Codex AI Terminal and carries the
  credential by a launch-named file if the variable does not survive.
- No current terminal status means "ready for a prompt" -> task 8.3 adds the signal per
  provider, and a provider without it gets no pointer.
- A provider treats message text as a command -> task 5.7 proves literal delivery per
  provider driver and stays open for a provider where that cannot be shown.
- The reference-docs drift test fails for new tools before the docs phase -> task 5.3
  checks whether the test covers provider tools and, if it does, adds the entries there.
- Three migrations are not needed, two are: a later phase adding one must take number 77
  and say so in `progress.md`.
- The work is one pull request across server, contracts and web -> phases keep their own
  commits so a reviewer can read them in order.

## Decisions

- P1. Send to agent between chat panels is built first, then agent messaging between chat
  agents, then the shared terminal work once. Alternatives: agent messaging first (the
  person-facing control lands last). Decided by: user.
- P2. One pull request for the whole plan. Alternatives: three pull requests by feature;
  one per phase. Decided by: user.
- P3. The module, table, method and type names in Global constraints. Alternatives: fold
  the new code into existing modules (`mcp/`, `production/`), which would put two features
  into files that are already several thousand lines. Decided by: agent's call.
- P4. All four Should requirements are planned (R15, R19, R20, R112); R112 is phase 10 and
  can be dropped alone. Decided by: user.
- P5. Every task is tested with scripted providers; one real-provider run closes the plan.
  Alternatives: scripted only; a real run per phase. Decided by: user.
- P6. A person's request to a terminal agent is a row of `agent_messages` with a person as
  sender and a link to its `send_requests` row. Alternative: a third table. Decided by:
  agent's call (spec D103 and D116 fix the behavior, not the layout).
- P7. The agent list in the control is built on the client from the shell and terminal
  metadata it already has, and the server validates every send. Alternative: a new server
  directory call for the web (duplicates `buildAgentRows`). Decided by: agent's call.
- P8. The spec for the plan is a joined copy with Part B renumbered R101 to R119.
  Alternative: two plan folders. Decided by: agent's call, stated to the user.
- P10. The messaging phases start one round later than the approved outline (phase 5 in round 3
  beside phase 3, phase 6 in round 4 beside phase 4, then 7 to 11 one at a time), because task 5.4
  must widen two web types that phase 2 also edits. Two rounds are parallel instead of three.
  Decided by: agent's call.
- P11. Each RPC method lands with its contract entry, method row, scope row and handler in one task
  (`send` in 1.2; `cancel`, `dismiss`, `subscribe` in 1.3; `getHandoffText` in 4.1;
  `getTerminalOutput` in 9.1), because the registry and the parity test must be complete at every
  commit. Handlers register from `send_requests/rpc.rs`. Decided by: agent's call.
- P12. Two capability flags, `sendRequests` and `agentMessaging`, let the web disable the new
  controls against an older remote server, as `codeReviews` does. Decided by: agent's call.
- P13. Three readings of the spec, approved by the user with the plan on 2026-11-13:
  (a) a thread is marked unread through the sidebar's workspace store, which the sidebar, the
  Agents view and the Inbox read, and the request stream is paged so that no undismissed request
  is dropped;
  (b) a Review sent to a new panel offers chat reviewers only; a reviewer launched as a terminal
  CLI has no BiBCode message to track and stays on the Code review button;
  (c) R117's "put Take over from first" is built as: agents with the out-of-tokens hint lead the
  Take over from list.
- P14. After the plan review, a person's send always queues behind a pending approval, a pending
  question, a held queue or an errored session (R113, R119 as written), and a Review to a new
  panel is a tracked request with an answer notice. The two departures first proposed for these
  were withdrawn. Decided by: review finding, accepted.
- P15. The answer text of a request is stored with the request (cut at 48,000 characters) and read
  through `sendRequests.getAnswer`, so Bring back works after the target moved on or was
  deleted. Decided by: agent's call (review finding 7).
- P16. Four tasks were split after the review: 1.5 and 1.6 out of 1.2 and 1.3, 5.7 out of 5.4, 8.6
  out of 8.4. The plan has 47 tasks. Decided by: agent's call (review note on task size).
- P17. The answer of a request is the turn's final assistant message or, when the turn ended with a
  proposed plan (a Claude reviewer in plan mode), that plan's text. The Send to agent spec's D16
  was amended for it. Decided by: user (plan review round 2, finding 4).
- P18. Accepted limit: a delivery that is being claimed at the instant agent messaging is switched
  off may still complete. R5's scenarios do not require more, and making the setting atomic with
  the claim would put a settings lock on the delivery path. Decided by: agent's call (round 2,
  finding 5).
- P19. Where the review asked for atomicity or race safety (cancel in every waiting state, a held
  or failed message never keeping a live queue entry), the tasks state the invariant and name the
  failing test, and leave the mechanism to the implementer. Decided by: agent's call.
- P20. A source thread is unread while it has an undismissed answered or not answered request the
  person has not opened; it is derived from the request list, with no stored timestamp. Decided
  by: agent's call (round 2, finding 9).
- P9. Skills: `rust-best-practices` was installed 2026-11-13 at user level for Claude Code
  and loads in a new session. Decided by: user.

## Appendix: questions record

- 2026-11-13 Q: where the plan goes / Recommended: `docs/plans/2026-11-13-agent-messaging/`
  / Decision: as recommended.
- 2026-11-13 Q: external sources / Recommended: none / Decision: none.
- 2026-11-13 Q: reviewer model and effort / Recommended: gpt-6-astra, high / Decision: as
  recommended.
- 2026-11-13 Q: which feature first / Recommended: Send to agent / Decision: as recommended (P1).
- 2026-11-13 Q: how many pull requests / Recommended: three / Decision: one (P2).
- 2026-11-13 Q: include the Should requirements / Recommended: all four, CLI reading last /
  Decision: as recommended (P4).
- 2026-11-13 Q: real-provider testing / Recommended: one real run per pull request /
  Decision: as recommended, which with one pull request is one run (P5).
- 2026-11-13 Q: outline of 11 phases and 47 tasks / Recommended: approve / Decision: approved.
- 2026-11-13 Q: install a Rust skill / Recommended: skip / Decision: install
  `rust-best-practices` (P9).
- 2026-11-13 Evidence: Codex plan review round 1 (Needs rework, 19 findings) / Decision: all 19
  accepted and applied; see reviews/plan-review-1.md.
- 2026-11-13 Evidence: Codex plan review round 2 (Needs rework, 15 findings; 17 of the 19 round-1
  fixes confirmed) / Decision: 9 fixed as facts, 2 turned into invariants with named tests, 2
  simplified away, 1 accepted as a recorded limit, 1 decided by the user; see
  reviews/plan-review-2.md. No third round was run.
- 2026-11-13 Q: what counts as a review's answer when a Claude reviewer ends with a plan card /
  Recommended: the plan's text / Decision: as recommended (P17).
- 2026-11-13 Evidence: lookup of commands, test layout and symbols at `a9938193b` /
  Decision: resolved without asking: latest migration is 74; unread is derived on the
  client; the review launcher already takes a one-off reviewer; the reference-docs drift
  test reads client tools.
