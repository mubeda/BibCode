# Plan: reliable agent activity status (#187)

Design: [`../specs/2026-10-27-agent-status-design.md`](../specs/2026-10-27-agent-status-design.md).
Branch `claude/b3-agent-status`, from `origin/develop` at `27702287cc`.

This plan covers design items D1 to D4. D5 (terminal agents) is designed in the
spec, but it needs the coordinator's decisions and is not part of this plan.

## Acceptance criteria and evidence

| Criterion from the issue                                                         | Evidence                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Documented failure cases with repros                                             | Spec §2: seven cases, derived from the code. Phase 2 confirms F1 and F2 by running the repro in the dev app, or records any it could not run.                                                                                                                                      |
| BiBCode and Orca compared, with the chosen design                                | Spec §3 and §4.                                                                                                                                                                                                                                                              |
| Cards correct for chat agents within seconds, after reconnect, and after restart | Engine tests through `dispatch` to the shell JSON (D1, D2), restart-reconcile assertions, and the `subscribeShell` hydration test. `AgentsPage` component test as the complete caller. Terminal agents: **not met until D5 is approved**, which the report states. |
| Silent agents do not stay in Working                                             | Pure decay tests (D3) and the `AgentsPage` test with an injected clock.                                                                                                                                                                                                         |
| Tests cover the mapping, the transitions and staleness                           | The tables below.                                                                                                                                                                                                                                                              |

## Steps (TDD, small commits)

1. **D1: Awaiting Input count.** Root cause: `apps/server/src/orchestration/engine.rs:7523`
   writes `pending_user_input_count = 0`.
   - First a failing engine test: dispatch a `user-input.requested` activity,
     and the shell reports `hasPendingUserInput: true`. Then add `resolved`, a
     stale failure, and a non-stale failure.
   - Then extract the open-request SQL from `repositories.rs:3052-3061` into one
     shared constant and use it in both places.
2. **D2: expiry on leaving `running`.** Root cause: the approvals projector
   (`engine.rs:7368-7451`) has no end-of-turn settlement.
   - Failing tests first:
     - `ready`, `error` and `interrupted` append `approval.expired` or
       `user-input.expired` in the same commit.
     - `running` and `starting` do not.
     - Repeating a status adds nothing.
     - A later request reopens the expired one.
   - Then implement in the `ThreadSessionSet` commit step (beside the `hold`
     logic, `engine.rs:5301ff`). The projector learns `expired`, and
     `request_is_recorded` treats an expiry as not recorded.
   - Add assertions to the restart-reconcile test (`provider_runtime.rs`
     `workspace_loss_tests` or the restart-reconcile tests). Test code only: no
     production hunks there.
   - Verify the order of OpenCode's `ready` on resume and its recovered asks.
     The recovered ask must arrive after the `ready` or reopen the request.
     Covered by the existing OpenCode resume test.
3. **D2, client side.** `apps/web/src/session-logic.ts`: `derivePendingApprovals`
   and `derivePendingUserInputs` close a request on `*.expired`. Tests first.
4. **D3: `lastActivityAt`.**
   - Add a migration for `projection_threads.last_activity_at`.
   - `rebuild_thread_derived_fields_tx` takes the event's `occurred_at`; the
     other callers pass `None`.
   - `thread_shell_with_records` emits the field.
   - The contract gains `lastActivityAt: Schema.optional(IsoDateTime)`.
   - Update the contract fixtures under `packages/contracts/fixtures/` where the
     shape tests need it.
5. **D3: client decay.**
   - Add `apps/web/src/components/sidebar/agentStatusFreshness.ts`. It holds
     the receipt map with stamping and pruning, and
     `AGENT_STATUS_STALE_AFTER_MS`.
   - `resolveThreadStatusPill` takes an optional `{ now, evidenceReceivedAt }`
     and returns `No update` for a stale Working or Connecting pill.
   - `resolveAgentGroup` maps `No update` to `done`.
   - `WORKSPACE_CARD_STATUS.stale` is an idle-kind glyph.
   - `useMinuteClock` drives the decay. Only rows in the Working group
     subscribe.
   - Non-live rows do not pulse (`AgentsRow.tsx`).
6. **D4: Failed.** `buildAgentRows` gives a session in `error` with no live pill
   the `Failed` pill, and the row stays in `done`. `AgentsRow` shows it.
7. **Docs.**
   - `docs/architecture/rpc-and-orchestration.md`: shell field, expiry, queue
     behavior.
   - `docs/user/workspace-ui.md`: Agents statuses and decay.
   - `docs/testing/cross-platform-validation.md`: Agents view status checks.
8. **Validation.**
   - Run `cargo fmt --all --check`.
   - Run `cargo test -p bibcode-server` on the engine, orchestration RPC,
     repositories, and the provider-runtime restart tests.
   - Run `cargo clippy -p bibcode-server --all-targets -- -D warnings`.
   - Run `vp check --no-fmt` and `vp check <changed files>`, then
     `vp run typecheck`.
   - From `apps/web`, run `vp test run --project unit` on the changed tests.
   - Run `vp test run packages/client-runtime/src/state/shell-sync.test.ts` and
     `vp test run scripts/bibcode-identity.test.ts`.
   - Review the changed React code against `vercel-react-best-practices` and
     `UI.md`.
   - Finish with the `git diff` and `git status` review.

## Files

**Owned files:**

- `apps/web/src/components/Sidebar.logic.ts` and its test
- `apps/web/src/components/sidebar/agentsSection.logic.ts` and its test
- the new `agentStatusFreshness.ts` and its test
- `apps/server/src/orchestration/engine.rs`
- `apps/server/src/production/orchestration_rpc.rs` (shell field only)

**Outside the owned list, needed for a complete fix (please confirm):**

| File                                                                                | Why                                       |
| ----------------------------------------------------------------------------------- | ----------------------------------------- |
| `apps/server/src/persistence/migrations.rs`                                         | New `last_activity_at` column             |
| `apps/server/src/persistence/repositories.rs`                                       | Shared predicate, `request_is_recorded`   |
| `packages/contracts/src/orchestration.ts` and fixtures                              | Optional `lastActivityAt`                 |
| `apps/web/src/session-logic.ts`                                                     | Chat honors expiry                        |
| `apps/web/src/components/agents/AgentsRow.tsx`                                      | `Failed` and `No update` label, no pulse when offline |
| The workspace card status glyph component                                           | Minute-clock subscription for Working cards |
| `apps/server/src/production/provider_runtime.rs`                                    | **Test code only**, for restart assertions |

## Not in this plan

- D5, terminal agents: designed, pending the coordinator's decisions.
- A fifth `AgentGroupId`.
- A server watchdog.
- A threshold users can configure.
- Rows for threads still waiting on their first delivery.
- Correcting for server clock skew on first sight after restart.
