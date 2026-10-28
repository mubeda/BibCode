# Stuck chat subagent (#206): plan, revision 2

Batch `stuck-subagent`, branch `claude/b3g-stuck-subagent` from
`claude/issue-batch-after-v0.12.0` (`0ecd10a38c`, which contains #187:
`git merge-base --is-ancestor f905efbce1 HEAD` succeeds). File:line references
are against that base. Revision 2 folds in Codex's ten findings and the lead's
decisions. I verified each finding against source; none was wrong. The
"Revision 2 changes" section maps each finding to the change.

## Acceptance criteria

1. Root cause of the user's stuck record: identified from the remote server's
   DB and logs, and written up. **This gate waits on the user's report.** If the
   report hasn't arrived by merge time, the criterion is reported unmet. The
   plan ranks no trigger.
2. A chat subagent never reads **Running** once a BiBCode-owned provider
   process that ran it is gone. This covers stop, removal, idle suspension,
   shutdown/update, relaunch, crash (no further delivery needed), and server
   start. Its actors and work items become `interrupted` with
   `updatedAt == terminalAt == closure time`. The reason and the genuine last
   report go in `summary`. Clients receive the change as journaled deltas, and
   a reconnect snapshot agrees with them.
3. Records of an external OpenCode server stay untouched on detach and at
   startup.
4. Turn end closes only what the complete live set proves finished. A late
   `SubagentStop` upgrades the record to `completed`.
5. No fake **Completed** label. **Stop unavailable** explains itself.
6. Unchanged: `SubagentStop` completion, task-notification cancellation,
   targeted Stop, AI Terminal interruption, the monitoring-disabled path, and
   #187's request-expiry rules.

## Root cause (from code)

No chat-scope reconciliation exists. Every path that ends a chat provider
process leaves the persisted actor `running`:

| Path | Code | Effect on activity |
| --- | --- | --- |
| Idle suspension | `suspend_idle_session` → `detach_session` (`production/provider_runtime.rs:11905`, `:12307-12340`) | Reaps the activity tasks. `compensate_cancelled_activity` (`:12408-12440`) republishes the scope **Live**. Records are untouched. |
| Stop, removal, dead-session cleanup | `stop_session` (`:11798`), lazy detach after a stream end (`:6523`, reached only by a later delivery) | Same `detach_session`. |
| App update, shutdown | `quiesce_for_update` (`production/runtime.rs:865`) → `shutdown_sessions` (`provider_runtime.rs:12368`) | Same `detach_session`. |
| Relaunch | inline teardown (`:9650-9700`) | `forget_live_activity` clears in-memory ids only, then compensates Live. |
| Crash | event-pump tail (`:10268-10300`) and supervisor `SessionStreamEnded` (`:6429-6450`) | Scope marked **Stale**. Records stay `running`, and nothing closes them without another delivery. |
| Server start | `production/runtime.rs:353-357` → `repository.rs:504-546` | Interrupts `source_kind = 'terminal'` only. |

The Claude tracker completes an actor only through `SubagentStop`
(`provider/claude/activity.rs:495-535`), and only for an actor in its in-memory
map (`:425-427`). A stop for an earlier process's actor can never arrive.

Hypotheses re-verified:

- H3, dropped `SubagentStop`: `hook_sink.rs:152-156` answers 503 or 410 with no
  log.
- H4, notification before the mapping: already deferred through
  `pending_terminal_by_task` (`provider/claude/runtime.rs:796-810`,
  `:1015-1021`). Only an actor whose mapping never arrives stays open.
- H5, hookless relaunch: the old process's actors can sit under a section that
  is no longer negotiated. That section is stale (`repository.rs:2137-2170`), and
  `apply_batch` refuses actor upserts there (`:827-831`).
- Update blocking: no code link. Which trigger leaked the user's record (crash
  then a later delivery, suspension, update, or relaunch) is decided only by the
  remote report (criterion 1).

## Design

### A. One journaled interruption path (repository + projection)

- Repository: `interrupt_scope_records(scope_id, native_event_key, closure)`
  runs in **one** `database.call` transaction:
  1. It reads the scope's records with status
     `starting | running | waiting | unknown`. With none, it commits nothing and
     returns no deltas: no `EmptyBatch`, no warning.
  2. For each record, last report = the later of the record's `updatedAt` and
     the newest `activity_entries.created_at` it owns. Claude never bumps an
     actor on tool hooks.
  3. It builds the interrupted summary. `status = interrupted`, and
     `updatedAt = terminalAt = max(record.updatedAt, now)`. This keeps the
     ordering fence: the repository fences on `updatedAt` (`:2367-2380`), and the
     client requires `terminalAt <= updatedAt` (`activityReducer.ts:109-126`)
     while the server requires `updatedAt <= terminalAt` (`model.rs:1400-1416`).
     `summary` = "`{reason}`; last report `{d}` after it started." with the
     existing summary appended after it when there is one, clipped to
     `ACTIVITY_SUMMARY_MAX_LENGTH`. `{d}` is a duration (`34m`, `2h`, `3d`), so
     the text never goes stale and needs no timezone.
  4. It applies them through the existing inner `apply_batch` body, refactored to
     take the open transaction, with a `terminalize_retained` mode. In that mode
     an actor or work-item upsert that only moves an **existing** record to a
     terminal state skips the capability check. This is finding 5: a retained
     record under a stale, unnegotiated section still closes. Counts, journal
     rows, revision, event idempotency and delta chunking all come from the
     shared code.
- Projection: `interrupt_unresolved_scope(scope_id, reason)` takes the scope's
  publication lock **once**, calls the repository function, then publishes the
  deltas and the apply completion. Both steps come from a private
  `apply_locked`-style helper that `apply()` also uses after taking the lock.
  `apply()` is never called while the lock is held (finding 1).
- Reasons, static and content-free:
  - "`{Provider}` session ended before this subagent reported" (actors), or
    "…before this task reported" (work items).
  - "BiBCode restarted before this subagent reported", with the same split, at
    startup.
- Failures: `tracing::warn!` with the thread id and counts only. Detach and
  shutdown never fail because of it.

### B. Ownership

- A process is BiBCode-owned unless it is OpenCode with a configured endpoint.
  The Codex, Cursor and Grok drivers hold `child: SharedChild`; OpenCode holds
  `Option<SharedChild>` and is `None` for an endpoint (`provider_runtime.rs:12985`,
  `:13531`, `:13789`, `:13998`, `:14045`). Claude always spawns its own process.
  The helper is `session_owns_provider_process(&launch)`.
- Durable evidence for startup: the OpenCode driver writes
  `"processOwner": "bibcode" | "external"` into its runtime payload, which is
  persisted in `provider_session_runtime.runtime_payload_json` by `persist_runtime`.
  At startup an OpenCode thread scope is interrupted only when its runtime row
  carries `"processOwner": "bibcode"`. A missing flag (rows from older builds) or
  `external` leaves it untouched. Every other chat provider's scope is
  interrupted because its driver always owns the process. This is consistent
  with #187's `EXTERNALLY_RESUMABLE_PROVIDERS` (`orchestration/engine.rs:7030`,
  `:2865-2880`), and #187's request rules are not touched.

### C. Call sites (complete callers)

Each runs only when `session_owns_provider_process` holds and Chat Activity is
admitted:

1. `detach_session`, after `cancel_and_reap_activity_tasks` and before
   `synchronize_activity_lifecycle`, so the lifecycle sees zero active, and
   before `compensate_cancelled_activity`. This covers stop, removal, idle
   suspension, the lazy dead-session detach and `shutdown_sessions` (update).
2. Relaunch teardown, before `forget_live_activity`.
3. Crash: the supervisor's `SessionStreamEnded` arm (`:6429-6450`), on **both**
   branches. After settlement, it runs once `settled` resolves. On the
   settlement-timeout branch, which stores `pending_stream_settlement`, it runs
   too, because the interruption touches only activity, not the core projection
   being settled. No later delivery is needed (finding 3). Queued non-terminal
   upserts from the dead process carry `updatedAt` earlier than the closure, so
   the fence drops them. A queued terminal one (a real `SubagentStop`) still
   overwrites `interrupted`, which is correct.
4. Startup (`production/runtime.rs:353`), next to the terminal pass and before
   `reconcile_abandoned_provider_sessions`: the chat projection walks thread
   scopes with active records. It applies ownership rule B and calls the same
   `interrupt_unresolved_scope` per scope with the restart reason. That is one
   code path, journaled, and repairs existing databases such as the user's.

### D. Turn end (Claude tracker)

- At a root `result`, close an open actor as `interrupted` (reason: "Claude
  ended its turn before this subagent reported") only when:
  - its correlator task mapping is known, and
  - Claude's live background set is **authoritative**: at least one
    `background_tasks_changed` has arrived in this process, and `overflowed` is
    false (`provider/claude/runtime.rs:1513-1545`), and
  - the task is absent from that set.

  Unmapped actors, or any actor while the set is incomplete, wait for process
  end (finding 6).
- Late-stop upgrade: an actor closed this way moves to `terminal_actors`,
  flagged as closed by turn end. A later `SubagentStop` from the same tracker
  upgrades it to `completed` with its summary. The repository accepts
  terminal→terminal at a newer `updatedAt`, and the client reducer accepts it.
- `ClaudeActorState` gains a last-hook time, so the turn-end summary uses the
  same "last report" text.
- Not chosen: never closing at turn end. A dropped stop hook would then show
  **Active** until idle suspension, which takes up to the 30-minute quiet cap
  plus the idle timeout.

### E. Client reducer (reopen convergence)

`resolveSummaryUpdate` refuses a terminal→non-terminal incremental update
(`activityReducer.ts:132-134`). After this change, a Codex resume can still
reopen an interrupted actor on the server with a newer provider timestamp
(`provider/codex/activity.rs:945-955`). The client would then keep Interrupted
while the server says running. Change: when an incoming non-terminal summary
for a terminal record has a strictly newer `updatedAt`, the delta is accepted
for its revision and `requiresSnapshotReconciliation` returns true, so the
client fetches the snapshot. Older or equal updates are still ignored. No
contract change.

### F. Web (owned files only)

- `activityPresentation.ts`: new `activityRecordTimeLabel(record, now)`:
  - completed: "Completed in X"
  - failed: "Failed after X"
  - cancelled: "Stopped after X"
  - interrupted: "Interrupted X ago"
  - active: "Elapsed X"

  It replaces `recordTime` (`ActivityRoster.tsx:291-297`), which today labels
  every terminal row "Completed in". The reason and last report come from
  `summary`, which the row already renders first (`:383-387`). Old servers'
  interrupted rows also stop reading "Completed".
- **Stop unavailable** (`ActivityRoster.tsx:395-403`): keep the short label, add
  an accessible description and tooltip, "`{Provider}` hasn't reported a way to
  stop this subagent yet." After this fix, an active row has no stop target
  only while its live runtime hasn't linked a task yet.
- `ActivityDock.tsx`: no code change expected; tests prove its counts move.

### G. Hook-drop log

`hook_sink.rs:152-156`: a counted `tracing::warn!` on `Full` (503) and `Closed`
(410). It carries `hook_event_name` and the drop count, logs the first drop and
then each power of two, and never logs the payload.

## Tests (through the real callers)

| Criterion | Test |
| --- | --- |
| Repository path | `tests/activity_repository.rs`: a single transaction interrupts thread-scope records, sets `updatedAt == terminalAt`, and sets a summary with reason and last report (including an existing summary). It journals one delta, is idempotent with no `EmptyBatch` on the second call, terminalizes a record under a stale unnegotiated section, and leaves terminal scopes alone. |
| No deadlock | `activity/projection.rs` unit test: `interrupt_unresolved_scope` completes under a timeout while another `apply()` for the same scope is queued, and both deltas publish in order. |
| Stop, suspension, shutdown, relaunch | `production/provider_runtime.rs` tests next to `removal_suspension_tests` and `IdleDeadlineFixture`, through `stop_session`, the idle deadline, `shutdown_sessions` and the relaunch teardown. Each asserts the record is interrupted, a published delta, counts active 0 / done N, and a final Live snapshot without an active actor. |
| Crash, no further delivery | A fixture driver ends its stream with an open actor, and no turn is sent. The record is interrupted after settlement. A second case forces the settlement timeout. |
| Hookless relaunch | Extend `tests/production_provider_runtime.rs::a_restarted_claude_without_hook_support_stops_reporting_live_subagents`: the old process's running actor becomes interrupted under the stale section, through a journaled delta. |
| Startup and ownership | `tests/server_runtime.rs` or `production_provider_runtime.rs`, starting the production runtime on a seeded DB. Claude and Codex thread scopes are interrupted. OpenCode with `processOwner: bibcode` is interrupted, while `external` or a missing flag is untouched. Then resume each OpenCode session and check the record matches what the provider reports. Terminal scopes are unchanged. |
| Update | `tests/production_maintenance.rs`: `quiesce_for_update` with an open actor leaves it interrupted. `prepare` with persisted running records completes within its normal time and never fails. |
| Claude turn end | `provider/claude/activity.rs` and `runtime.rs` unit tests: a mapped absent actor closes when the set is authoritative. Overflow, then turn end, then a late `SubagentStop` gives no close at turn end and `completed` from the stop. Close-by-absence followed by a late stop upgrades to completed. Unmapped actors stay open. A stopped notification before the mapping is applied once the mapping arrives. |
| Dropped hook | `tests/provider_claude.rs`: a fixture run whose stop hook is answered 503 ends `interrupted` after the process ends. A `hook_sink` unit test counts the 503 and 410 drops. |
| Codex resume race and #187 agreement | `production_provider_runtime.rs`: a Codex session is interrupted on stop, and a concurrent resume re-reports the same child active. The server record follows the newer report. Thread status (#187 shell: session status, `lastActivityAt`) and Activity counts agree after the race and after a fresh snapshot. `activityReducer.test.ts` covers the client side: the reopen delta triggers a snapshot, which converges. |
| Conformance | New `chat-process-ended-interrupts-active` scenario in `canonical-scenarios.json`. Its checkpoint drives Claude, Codex and OpenCode actors through the projection path; the caller-level tests above prove the callers. |
| Web | `activityPresentation.test.ts` (labels per lifecycle). `ActivityRoster.test.tsx`: interrupted row under Done with reason, last report and "Interrupted X ago", plus the explained no-target state. `ActivityDock.test.tsx`: Active 1 / Done 17 becomes Active 0 / Done 18. |
| Client runtime | `activityReducer.test.ts`: running → interrupted by delta, and by replacement snapshot after reconnect, plus the reopen case above. |
| Packaged desktop | `chat-activity-panel.e2e.ts`, at the end of the existing `it`: dispatch `thread.session.stop` through a new `stopDesktopActivitySession()` export in `support/activity-session.ts`. The fixture's active "Fixture reviewer" child (marker cleared) leaves **Active** and reads Interrupted under **Done** with the reason. **Running it is required.** I'll tell the lead when ready and not start it myself. |

## Docs and runbooks

- `docs/architecture/activity-observation.md`:
  - the teardown section (`:59-66`): chat-scope interruption, ownership, and
    closure timestamps;
  - the reducer rule (`:54-57`): a newer reopen now triggers a snapshot;
  - the Claude structured section: turn-end close and late-stop upgrade;
  - Troubleshooting states.
- `docs/user/workspace-ui.md` § "Activity and targeted Stop": interrupted rows,
  the time labels, the Stop explanation.
- `docs/providers/claude.md` § "Activity observation": hook delivery, what ends a
  subagent, and the hook-drop log.
- `docs/testing/cross-platform-validation.md` § "Claude activity probe behind a
  shim" (`:770-805`):
  - Step 5 expects the earlier subagent row to read **Interrupted** with
    "Claude session ended before this subagent reported", under **Done**,
    beside the retained-activity message.
  - The command list gains the new relaunch and startup tests.
- The desktop UI runbook gains the e2e step if it lists cases.
- A historical spec is not needed: there's no contract change and no new state.

## Gates

- `cargo fmt --all --check`
- `cargo clippy --workspace --all-targets -- -D warnings`
- The focused `cargo test -p bibcode-server` lib filters, plus the integration
  targets `activity_repository`, `activity_provider_conformance`,
  `provider_claude`, `production_provider_runtime`, `production_maintenance` and
  `server_runtime`
- The full `vp check` (the app-written `.claude/settings.local.json` is left
  alone; if it fails only there, I report it)
- `vp run typecheck`
- `vp test run --project unit` for web and client-runtime
- `vp test run scripts/bibcode-identity.test.ts`
- `vp run check:contracts` is not needed, because contracts don't change.
- Reviews: UI.md and vercel-react-best-practices on `ActivityRoster` and
  `activityPresentation`.
- The packaged desktop run, when the lead schedules it.

## Profiler coverage

The change adds no child process, RPC method, binary or worktree path. The
interruption and hook-drop records are plain `tracing::warn!` lines carrying
counts, thread ids and hook event names. No prompt or subagent text is recorded.

## Residual risks

- A Codex resume that genuinely re-reports a dead child as active reopens it.
  The client now converges on that truth, but the original "Running forever" can
  persist for Codex if Codex's own state is stale. This is documented, not fixed
  here.
- An OpenCode row written before this change has no `processOwner`, so it is
  left untouched at startup. Its next detach closes it.

## Skipped (ponytail)

A new lifecycle state, a contract field, manual dismiss, the client "No update
for X" label, a longer quiet cap, the 1 s versus 2 s hook timeout mismatch, and
Codex/OpenCode AI Terminal teardown.

## Revision 2 changes (Codex findings → change)

1. Deadlock: a single lock with a single transaction, and `apply()` is never
   called under the lock (A).
2. Timestamps: `updatedAt == terminalAt == closure`, with the last report in
   `summary` (A.3); the delta and reconnect are tested.
3. Crash: the `SessionStreamEnded` arm on both branches, with no lazy detach (C.3).
4. Startup ownership: the persisted `processOwner` flag; external OpenCode is
   untouched on both detach and startup; #187 is preserved (B, C.4).
5. Capability loss: the `terminalize_retained` mode in the journaled path; the
   hookless relaunch is tested (A.4).
6. Overflow: close-by-absence only with an authoritative set; tested (D).
7. Startup reason and time: the same path writes the reason and last report into
   every `summary`, including an existing one (A.3, C.4).
8. Complete callers: caller-level tests, the Codex race, #187 agreement, the
   reducer convergence, and the packaged run (Tests, E).
9. Runbook and gates: the shim procedure is updated; the full `vp check` and
   workspace Clippy are run (Docs, Gates).
10. Trigger ranking removed: the remote report is acceptance gate 1.

## Revision 3 (Codex second pass, folded in during implementation)

1. **Equal-timestamp reopen.** The reducer treats a non-terminal update of a
   visible terminal summary at the same or a newer `updatedAt` as a gap. It
   returns before advancing the revision. `activity.test.ts` drives the client
   recovery caller: exactly one snapshot fetch, convergence on the reopened
   row, and no second fetch for a duplicate delta.
2. **Malformed live set.** `background_tasks_changed` is complete only when
   every non-ambient task has a usable `task_id`. A missing `tasks` array, an
   unnamed task, or an overflow makes it incomplete.
   `turn_end_activity_tests.rs` covers the unnamed-task frame followed by a
   root `result`: the mapped actor stays open.
3. **OpenCode ownership end to end.** `OpenCodeDriver::start` returns
   `{"processOwner": "bibcode" | "external"}` from `child.is_some()`. The test
   `opencode_records_who_runs_its_server_and_startup_closes_only_bibcode_owned_work`
   launches a real `OpenCodeDriver` through the supervisor against an HTTP
   fixture, reads the persisted runtime row, and runs the startup repair. The
   flag is never seeded. An owned server uses a stand-in child process. Live
   detach uses `ProviderDriver::owns_native_work`, the existing ownership
   predicate, rather than the launch endpoint.
4. **Remote and older servers.** `activity.test.ts` covers both: a reconnected
   subscription whose snapshot shows the interrupted row and its counts with no
   extra fetch, and an older server's running deltas, which apply with no
   refetch and unchanged counts.

Placement changes from the table above:

- The caller-level stop, suspension, shutdown, crash, external-server and Codex
  reopen tests live in `production/provider_runtime.rs` next to the
  `IdleDeadlineFixture`.
- Startup ownership is covered by `production/runtime.rs` and
  `tests/production_maintenance.rs`.
- The dropped-hook proof is the `hook_sink` unit test plus the process-end
  tests. `tests/provider_claude.rs` gained no case, because the fixture adapter
  there has no process to end.

## Revision 4 (diff review)

1. **Stale stream-end closure.** The closure is bounded with
   `ActivityInterruption::reported_until`, set to the stream's end, so only
   records last reported then or earlier close. It is held in
   `SessionEntry::stream_end_closure` and awaited by
   `cancel_and_reap_activity_tasks`, so it finishes before a relaunch replaces
   the entry or the supervisor stops. That join makes a separate generation
   check unnecessary: a newer generation of the scope can only start after the
   entry that owns the closure is reaped.
2. **One ownership rule.** `StartupProcessOwnership`
   (`orchestration/process_ownership.rs`) is read before abandoned sessions
   settle. The startup activity close and #187's startup request expiry both
   use it. A row with no recorded owner follows the settings: a configured
   OpenCode Server URL means the work may still run.
3. **Time label.** "Interrupted after {ranFor}", with no dependence on the
   current time.
4. **Relaunch failure.** `restart_session` closes the old records when the
   driver's shutdown fails, before the error propagates.
5. **Unreadable rows.** These are skipped and counted in a content-free
   warning, and the rest of the scope closes.
6. **Tests.**
   - `update_protection_closes_a_live_claude_subagent` drives `prepare()`.
   - The Codex reopen test asserts the #187 fields on both sides of Stop.
   - The OpenCode startup test keeps its event stream open.
   - `a_bounded_closure_…` and `a_restart_settles_or_keeps_…` are new.
7. **Copy.**
   - Turn-end summary: "Claude stopped listing this subagent as running".
   - Stop tooltip: "… can't stop this subagent on its own. Stop the turn to
     end it."
8. **Docs.** The provider matrix now lists `background_tasks_changed`.

## Remote server prompt (read-only, for the user to run with Claude on the server)

```
Read-only investigation for BiBCode issue #206 (a Claude subagent stuck "Running").
Do not modify, delete, restart or kill anything. Never print prompt or message
text: do not select summary_json, payload_json (except the session.status field
named below) or any transcript. Report only ids, statuses, timestamps and the log
lines asked for.

1. Versions: `bibcode --version` (or the BiBCode server version in
   ~/.bibcode/userdata/logs/server.log's first lines) and `claude --version`.
2. Open the DB read-only: `sqlite3 -readonly ~/.bibcode/userdata/state.sqlite`
   (if sqlite3 is missing: python3 with
   sqlite3.connect('file:'+path+'?mode=ro', uri=True)).
   a. Stuck records:
      SELECT s.thread_id, s.scope_id, s.generation_id, s.is_current,
             s.observation_state, s.capabilities_json, s.updated_at AS scope_updated_at,
             r.record_kind, r.record_id, json_extract(r.summary_json,'$.role') AS role,
             r.status, r.started_at, r.updated_at, r.terminal_at
      FROM activity_records r JOIN activity_scopes s USING(scope_id)
      WHERE s.source_kind='thread' AND r.status IN ('starting','running','waiting','unknown');
   b. For each thread_id from (a), with T = that id:
      SELECT status, last_seen_at, provider_name FROM provider_session_runtime WHERE thread_id=T;
      SELECT occurred_at, event_type, json_extract(payload_json,'$.session.status') AS session_status
      FROM orchestration_events WHERE stream_id=T
        AND event_type IN ('thread.session-set','thread.session-stop-requested',
                           'thread.turn-start-requested','thread.turn-interrupt-requested')
      ORDER BY sequence;
      SELECT MAX(created_at) FROM activity_entries WHERE scope_id=<scope_id> AND owner_id=<record_id>;
3. Logs: for each thread id T,
   grep -h "T" ~/.bibcode/userdata/logs/server.log* | grep -E \
     "stopped reporting|suspending an idle provider session|observes_subagents|probe|unsupported|relaunch|stream ended|session.exited|503|410|hook"
   and, without the thread filter:
   grep -hE "drain timed out|quiesce timed out|blockers|update not installed|protection|maintenance" \
     ~/.bibcode/userdata/logs/server.log*
   Keep only the timestamp, level, message and the structured key=value fields;
   drop any field that holds free text from a prompt or reply.
4. Convert started_at, updated_at, terminal_at and the matching log timestamps
   to America/Buenos_Aires (TZ=America/Buenos_Aires date -d "<iso>").
5. Report: the stuck record's role, started/updated (UTC and local), the session
   runtime transitions around its updated_at, which of these happened after it:
   idle suspension (and its live_subagents value), relaunch, stream end/crash,
   server restart, update; any 503/410 hook lines; and the exact update failure
   line(s).
```
