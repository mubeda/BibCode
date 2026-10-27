# Plan: reliable agent activity status (#187), revision 2

Design: [`../specs/2026-10-27-agent-status-design.md`](../specs/2026-10-27-agent-status-design.md).
Branch: `claude/b3-agent-status`, cut from `origin/develop` at `27702287cc`.
Shared row contract with #186: `scratchpad/batch3/agent-row-contract.md`.
Rust work uses this worktree's own `target/` with `CARGO_BUILD_JOBS=3`.

Scope: D1–D5. Terminal agents are in scope, as the lead decided.

## Acceptance criteria and evidence

| Criterion                                                                                              | Evidence                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Failure cases are documented, with repro steps                                                        | Spec §2. These were derived from the code. Phase 2 runs the F1 and F2 repros in the dev app, or records which ones it could not run.                                                                                       |
| A BiBCode/Orca comparison and the chosen design are written up                                         | Spec §3–§4                                                                                                                                                                          |
| Chat and terminal cards are correct within seconds of a change, after a reconnect, and after an app restart | Engine and observer tests, plus the joined caller test (spec §5): publication → hydration → reconnect → restart → grouping → card                                                                       |
| Silent agents leave Working                                                                            | D3 decay into `unknown`/`stale`, with pure tests and mounted threshold tests (AgentsPage row, workspace card)                                                                                            |
| Tests cover the mapping, the transitions and staleness                                                 | Spec §5                                                                                                                                                                             |

## Steps

Work test-first and commit in small steps.

1. **D1: pending-input count.**
   - Root cause: `engine.rs:7523` always writes `pending_user_input_count = 0`.
   - Change: share the queued-head predicate (`repositories.rs:3052-3061`) as
     a single constant. The activities projector recomputes the count only on
     request-state kinds. `rebuild_thread_derived_fields_tx` stops writing the
     column.
   - Tests come first, and include a case showing that an assistant delta does
     not recompute the count.
2. **D2a: stale respond failure.**
   - The approvals projector (`engine.rs:7384-7391`) handles a
     `provider.approval.respond.failed` whose detail is stale or unknown. It
     uses the same detail rule as migration 1604-1640.
   - Test: while the session is still running, a stale failure clears Pending
     Approval.
3. **D2b: expiry.**
   - When a `ThreadSessionSet` commit leaves `running` or `starting`, append
     `approval.expired` or `user-input.expired` beside the `hold` step
     (`engine.rs:5295ff`).
   - The projector gains an `expired` status that a later request can reopen.
   - `request_is_recorded` treats an expired request as not recorded.
   - Tests:
     - same-commit append, no duplicates, and reopen;
     - queue: an expiry at `ready` drains like an answered approval, and an
       expiry on interrupt or error stays held;
     - restart assertions in the `provider_runtime.rs` test modules (test code
       only).
   - Verify:
     - the order of OpenCode's resume `ready` relative to its recovered asks,
       using the existing resume test;
     - the Claude adapter's `restore_from_snapshot`
       (`provider/claude/runtime.rs:2650`). Today only test code calls it. If
       a production caller appears, a restored request must re-emit its
       `request.opened` or `user-input.requested`.
4. **D2 client.** In `apps/web/src/session-logic.ts`, `*.expired` closes a
   request and a later request reopens it. Tests come first.
5. **D3 evidence.**
   - Migration: add `projection_threads.last_activity_at`.
   - Set it only for provider-attributed events (`infer_actor_kind`) and for
     session-sets to `running` or `starting`.
   - Add the shell field and `lastActivityAt: Schema.optional(IsoDateTime)`.
   - Regenerate the contract fixtures and commit them.
6. **D3 client.**
   - Add `AgentGroupId` `unknown` and `AgentRow` fields
     `unknownReason: "stale" | "unavailable" | "offline" | null` and
     `terminalId: string | null`, using the names confirmed with b6b-inbox.
   - Export `STATUS_TONES`, adding the `failed` and `unknown` keys.
   - Add `apps/web/src/hooks/useAgentFreshness.ts`. It holds the
     receipt/evidence map, skew-free age, `useAgentRows`, and
     `useWorkspaceCardStatus`.
   - The pure resolvers take `{ now, evidenceAt, environmentLive }`.
   - `Sidebar.tsx` gets one-line call-site changes at 873 and 1411.
   - `AgentsRow.tsx`: reason labels, no pulse in `unknown`, and an optional
     `onJumpToWorkspace?`.
   - Only chat rows are passed to `useAgentsUnread`. b6b-inbox owns that file,
     as agreed.
7. **D4: Failed.** Show a `Failed` pill inside `done`.
8. **D5 server.**
   - `TerminalSummary.agentStatus` is computed at serialization time with
     `ageMs`.
   - Observers attach for every observable AI Terminal. Activity publication
     stays `Dormant` unless `enableTerminalAgentActivity` is on.
   - Claude: add the hook events listed in the design and bound their
     validation.
   - Codex: root-thread status mapping, confined to the observer and
     status-emission regions only (~802 onward). Do not touch ~451–505 or
     `supervisor.rs` ~481.
   - OpenCode: session and ask mapping.
   - An unobserved terminal reports `unavailable`.
   - Tests for each provider, plus an RPC metadata-snapshot test.
9. **D5 client.**
   - One row per AI Terminal, keyed `${threadKey}#terminal:${terminalId}`.
   - Sessionless worktrees get rows.
   - Activation goes through `terminal:${terminalId}` on the center panel.
   - The card uses the most urgent state among its chat and terminal rows.
   - Cursor, Grok, Windows, and unobserved terminals show
     `unknown`/`unavailable`.
10. **Joined caller test.** Drive a fake RPC session through the client-runtime
    shell and terminal-metadata states into the mounted AgentsPage and
    workspace card. Cover publication → hydration → reconnect → restart
    (cached → offline → live) → grouping → card.
11. **Docs and runbooks.**
    - `rpc-and-orchestration.md`, `activity-observation.md`,
      `providers/claude.md`, `user/workspace-ui.md`. The user guide covers the
      default change and the provider matrix.
    - Runbooks: `testing/cross-platform-validation.md` (terminal availability
      per OS, per-terminal navigation, offline and restart) and
      `testing/ssh-environments.md` (remote terminal status, network drop).
12. **Validation.**
    - Rust:
      - `cargo fmt --all --check`
      - `cargo test -p bibcode-server`, on the engine, orchestration RPC,
        repositories, provider_terminal, terminal RPC and provider-runtime
        restart tests
      - `cargo clippy -p bibcode-server --all-targets -- -D warnings`
    - Web and repo checks:
      - `vp check --no-fmt` and `vp check <changed files>`
      - `vp run typecheck`
      - `vp test run --project unit <paths>`, from `apps/web`
      - the client-runtime shell-sync tests
      - `vp test run scripts/bibcode-identity.test.ts`
    - Reviews: changed React code against `vercel-react-best-practices` and
      UI.md.
    - Final check: review `git diff` and `git status`.

## Files

All files below are owned or granted.

- **Web logic:** `Sidebar.logic.ts`, `agentsSection.logic.ts`, and their tests.
- **Web hooks and session logic:** the new `hooks/useAgentFreshness.ts` and its
  test, and `session-logic.ts`.
- **Web components:**
  - `AgentsRow.tsx` and its new test
  - `AgentsPage.tsx`
  - `AgentsNavRow.tsx`
  - `Sidebar.tsx` (one-line call sites only)
- **Server:**
  - `orchestration/engine.rs`
  - `production/orchestration_rpc.rs`, for the shell field
  - `persistence/migrations.rs`
  - `persistence/repositories.rs`
  - `provider_terminal/{claude,opencode,model}.rs`
  - `provider_terminal/codex.rs`, observer region only
  - the terminal manager's summary serialization
  - `provider_runtime.rs`, test code only
- **Contracts:** `packages/contracts/src/{orchestration,terminal}.ts` and the
  regenerated fixtures.

## Not in this plan

- A server watchdog
- A user-configurable threshold
- Rows for threads still awaiting their first delivery
- Hook-based status for Cursor and Grok terminals
- A Windows terminal observer
