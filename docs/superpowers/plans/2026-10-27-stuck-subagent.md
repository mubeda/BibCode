# Stuck chat subagent (#206): plan

Batch `stuck-subagent`, branch `claude/b3g-stuck-subagent` from
`claude/issue-batch-after-v0.12.0` (`0ecd10a38c`). File:line references below
are against that base.

## Acceptance criterion

A chat subagent never reads **Running** once the provider process that owned it
is gone. On every process-ending path the server moves the thread scope's open
actors and work items to `interrupted`, with `terminalAt`, a short reason and a
last-seen time. Clients receive the change as ordinary activity deltas. A
one-time-per-start pass repairs records already stuck in existing databases. The
row never shows a fake **Completed**, and **Stop unavailable** explains itself.

## Root cause (from code)

**Confirmed: nothing reconciles chat-scope records when the process ends.**
Every path that ends a chat provider process leaves the persisted actor
`running`:

| Path | Code | What it does to activity |
| --- | --- | --- |
| Idle suspension | `suspend_idle_session` → `detach_session` (`production/provider_runtime.rs:11905`, `:12307-12340`) | Reaps the activity tasks, then `compensate_cancelled_activity` (`:12408-12440`) republishes the scope **Live** with its capabilities. Records are untouched. |
| Stop, removal, dead-session cleanup | `stop_session` (`:11798`), the lazy detach after a stream end (`:6523`) | Same `detach_session`. |
| App update, server shutdown | `quiesce_for_update` (`production/runtime.rs:865`) → `ProviderRuntime::shutdown` → `shutdown_sessions` (`provider_runtime.rs:12368`) | Same `detach_session` for every session. |
| Relaunch | inline teardown (`:9650-9700`) | `forget_live_activity` clears the in-memory ids only, then compensates Live. Does not go through `detach_session`. |
| Crash (stream ends by itself) | event pump tail (`:10268-10300`) | Marks the scope **Stale**. Records stay `running` until the next turn start detaches the session. |
| Server start | `production/runtime.rs:353-357` → `repository.rs:504-546` | Interrupts `source_kind = 'terminal'` only. Thread scopes are skipped. |

The Claude tracker can only complete an actor through `SubagentStop`
(`provider/claude/activity.rs:495-535`), which it accepts only for an actor in
its in-memory `actors` map (`:425-427`). A new process has a new tracker, so a
stop for an older actor can never arrive. The AI Terminal observer, by
contrast, interrupts its tracked actors when it ends
(`provider_terminal/claude.rs:1472`, `:1716-1750`).

**Inference to confirm with the remote data.** The user saw no stale banner.
A crash leaves the scope `Stale` until the next turn. Suspension, shutdown and
relaunch republish it `Live` at once. Four days of **Running** with no banner
therefore point at a detach-family trigger: idle suspension (H2) or the app
update/shutdown. An unhandled crash fits less well. The remote prompt below
collects what tells them apart.

**Other hypotheses, re-verified.**

- H3 (lost `SubagentStop`): `hook_sink.rs:152-156` still answers 503/410 with no
  log. Any lost stop leaves the actor open until the process ends, which this
  fix now closes.
- H4 (`task_notification(stopped)` before the task→agent mapping): already
  deferred. `remember_terminal_task` keeps it in `pending_terminal_by_task`
  (`provider/claude/runtime.rs:796-810`), and `reconcile` applies it when the
  mapping arrives (`:1015-1021`). Only an actor whose mapping never arrives,
  such as a foreground subagent interrupted mid-call, stays open. Process-end
  reconciliation closes it.
- H5 (relaunch without a hook sink): covered by the relaunch call site below.
  The actors of the old process are interrupted before the new process starts.
- Update blocking: still no code link. `prepare` and `quiesce_for_update` read no
  activity. The fix adds bounded DB work to `shutdown_sessions` under the same
  30 s deadline (see Risks). The remote logs decide whether the update failed for
  another reason.

## Changes per desired-behavior item

### 1. Process end → `interrupted` (server, provider-agnostic)

- New `ActivityProjection::interrupt_unresolved_scope(scope_id, reason, event_key)`
  in `activity/projection.rs`. It holds the scope's publication lock, reads the
  scope's active records through a new repository read, builds full
  `UpsertActor` and `UpsertWorkItem` mutations, and sends them through `apply()`.
  `apply()` journals and publishes deltas, so an open subscription sees the
  change. The repository `interrupt_*` functions bump the revision without a
  journal row, which is fine at startup but not for a live suspension. The read
  returns only records with status `starting | running | waiting | unknown`, so a
  second call is a no-op. Batches stay at 128 records or fewer (under the
  256-mutation limit), and a bounded loop handles larger scopes.
- Capability check: `apply_batch` rejects an actor upsert when
  `scope.capabilities.actors` is false (`repository.rs:827-831`). Section
  invariants (`:2137-2170`) let actor records sit under an un-negotiated, stale
  section. The helper therefore skips a record kind whose capability the scope no
  longer has and logs a count-only warning. Startup repair (item 6) still covers
  those records.
- An empty read returns early. `apply_batch` rejects an empty batch with
  `EmptyBatch`, and a clean detach must not log a warning.
- Call sites in `production/provider_runtime.rs`, each after
  `cancel_and_reap_activity_tasks`. The activity dispatch queue is drained by
  then, so no queued upsert from the dead process (with an `updatedAt` newer than
  last seen) can revive the record:
  - `detach_session`, before `synchronize_activity_lifecycle`, so the lifecycle
    sees zero active, and before `compensate_cancelled_activity`. This covers
    idle suspension, stop, removal, the lazy dead-session detach and
    `shutdown_sessions`, which is the update path.
  - The relaunch teardown, before `forget_live_activity`.
  - Crash: the supervisor's `SessionStreamEnded` arm (`:6429-6450`), once
    settlement finishes and the activity tasks are reaped. If reaping there
    conflicts with the lazy detach, the lazy detach (`:6523`) stays the crash
    path, and the window lasts until the next turn start.
- Gate: only a session whose driver owns its provider process. An OpenCode
  driver attached to a configured external server (`child: None`,
  `provider_runtime.rs:13996`) can outlive the BiBCode session, so its children
  are not interrupted on detach. Startup repair still runs for all of them.
- Reason text, static and content-free: "{Provider} session ended before this
  subagent reported", with "…this task reported" for work items. The label is
  Claude, Codex or OpenCode, derived from `launch.provider`.
- Failures log `tracing::warn!` with the thread id and counts only, and never
  block detach or shutdown.

### 2. Turn end and `background_tasks_changed` (Claude tracker)

Decision: close at turn end only what is provably finished. Recover from the
hook/stdout race with a late-stop upgrade.

- The race. Hooks arrive over HTTP into an mpsc channel that a separate task
  drains (`provider_runtime.rs:18267-18297`), while `result` arrives on stdout
  (`:18233-18265`). If a turn-end close interrupts an actor and its
  `SubagentStop` lands a moment later, the `"SubagentStop" if
  actors.contains_key` arm (`activity.rs:425`) drops the stop. A finished
  subagent would then read Interrupted.
- Rule: at a root `result`, the tracker interrupts each open actor whose
  correlator task mapping is known and whose task is not in
  `ClaudeBackgroundTasks.live`. Such an actor was foreground, or its background
  task left Claude's live set. Unmapped actors are left to the process-end path.
  Claude cannot prove them foreground, and interrupting a live background agent
  would hide its later tool hooks.
- Late-stop upgrade: an actor interrupted at turn end moves to
  `terminal_actors`, marked as closed by turn end. A later `SubagentStop` for it,
  in the same tracker, upgrades it to `completed` with its summary. The
  repository already accepts terminal→terminal with a newer `updatedAt`
  (`repository.rs:2367-2380`), and the client reducer only rejects
  terminal→non-terminal.
- Not chosen: never closing at turn end. That relies on process end alone, with
  latency of up to the 30-minute quiet cap plus the idle timeout. A dropped 503
  would show **Active 1** for up to about an hour.
- Last seen at turn end: `ClaudeActorState` gains a last-hook time, bumped by
  each owned tool hook, so the turn-end close can follow the item-3 rule.
- Changes: `provider/claude/activity.rs` adds a turn-end close and the
  late-stop path. `provider/claude/runtime.rs` passes the mapped task ids and the
  live background set to the tracker on a root `result`, and on
  `background_tasks_changed` when no turn is open.

### 3. Interrupted, not Completed: reason and last seen

No contract change. The existing `interrupted` lifecycle carries:

- `summary` = the reason, when the record has no summary. A running Claude chat
  actor always has `summary: None` (`activity.rs:477`). An existing summary is
  kept. Old clients already render `summary`.
- `updatedAt` = last seen: the later of the record's `updatedAt` and the newest
  `activity_entries.created_at` the record owns. Claude does not bump the actor
  on tool hooks, so its `updatedAt` alone is the start time. `terminalAt` = now.
  `validate_record_chronology` (`model.rs:1400-1416`) requires
  `startedAt ≤ updatedAt ≤ terminalAt`, which holds. Startup repair uses the same
  rule.
- Web (`activityPresentation.ts`, `ActivityRoster.tsx`): `recordTime` today
  prints "Completed in X" for every terminal row (`ActivityRoster.tsx:291-297`),
  including interrupted, failed and cancelled. A new
  `activityRecordTimeLabel(record, now)` in `activityPresentation.ts` returns
  "Completed in X", "Failed after X", "Stopped after X", and for interrupted rows
  "Last seen X ago", computed from `updatedAt`.

### 4. No dead-end Stop

After items 1 and 6, an actor from a dead process is under **Done**. An active
row with no target is now only one the live runtime has not yet linked to a
task. `ActivityRoster.tsx:395-403` keeps the short "Stop unavailable" label but
adds an accessible description and tooltip: "{Provider} hasn't reported a way
to stop this subagent yet." The copy lives in `activityPresentation.ts`.

### 5. Remote and older servers

Everything is server-side and runs the same for local and remote. A new client
against an older server keeps today's behavior, except that the honest time
label (item 3) also fixes "Completed in X" on that server's interrupted rows.
Skipped: client-side "No update for X" on active rows. A Claude actor's
`updatedAt` is its start time, so that label would mislead.

### 6. Startup repair

`production/runtime.rs:353`: next to the terminal call, the chat projection runs
`repository.interrupt_unresolved_activity_scopes("BiBCode restarted before this
subagent reported", AgentActivitySource::Chat)` through a new projection
wrapper, because the projection's repository is private. The function already exists
(`repository.rs:272-288`) and nothing calls it yet. It applies the item-3
last-seen and summary rule. `append_interruption_entry` hardcodes the
`activity:monitoring-disabled:` id prefix (`repository.rs:715-718`); it gains a
namespace parameter, so the restart entry gets `activity:server-restart:`. No
provider session is live at startup: `reconcile_abandoned_provider_sessions`
runs right after.

### Hook-drop log (H3 evidence)

`hook_sink.rs:152-156` adds a counted `tracing::warn!` on `Full` (503) and
`Closed` (410). It carries the `hook_event_name` and a running drop count, and
logs the first drop and then each power of two. There is no payload, agent text
or id beyond the hook event name. Out of scope: the 1 s handler timeout versus
the 2 s server body timeout.

## Files I will touch

- Server: `apps/server/src/activity/{projection,repository}.rs`,
  `apps/server/src/production/{provider_runtime,runtime}.rs`,
  `apps/server/src/provider/claude/{activity,runtime,hook_sink}.rs`.
- Server tests: `apps/server/tests/{activity_repository,activity_provider_conformance,provider_claude}.rs`
  and `apps/server/tests/fixtures/activity-conformance/canonical-scenarios.json`.
- Web, owned files only: `apps/web/src/components/activity/{activityPresentation.ts,activityPresentation.test.ts,ActivityRoster.tsx,ActivityRoster.test.tsx,ActivityDock.test.tsx}`.
  `ActivityDock.tsx` changes only if the dock test shows a need.
- Client runtime: `packages/client-runtime/src/state/activityReducer.test.ts`
  (tests only; the reducer already handles both paths).
- Desktop e2e: `apps/desktop/e2e/specs/chat-activity-panel.e2e.ts` and
  `apps/desktop/e2e/support/activity-session.ts` (one new export), typechecked
  only; the run is scheduled by the lead.
- Docs: `docs/architecture/activity-observation.md` (teardown section `:59-66`,
  Claude structured section, Troubleshooting states), `docs/user/workspace-ui.md`
  ("Activity and targeted Stop"), `docs/providers/claude.md` ("Activity
  observation"), `docs/skills/bibcode-profiler/references/` only if the new log
  lines count as profiler-visible (they are plain `tracing`, so probably not).
  Testing runbooks get reviewed; the desktop UI runbook gains the new e2e case if
  it lists cases.

I do not touch `ActivityPane.tsx`, ChatView timeline code, `packages/contracts`,
or the e2e fixture shim.

## Tests per acceptance criterion

| Criterion | Test |
| --- | --- |
| Startup interrupts thread scopes, leaves terminal scopes alone | `tests/activity_repository.rs`: seed a running actor and a waiting work item in a thread scope, plus a running actor in a terminal scope. The chat startup pass interrupts only the thread pair, sets `summary`, `updatedAt` (= last entry time) and `terminalAt`, and is idempotent. The terminal pass is unchanged. |
| Idle suspension, `shutdown_sessions` and relaunch interrupt and do not republish Live with the actor active | `production/provider_runtime.rs`, next to `removal_suspension_tests` and `IdleDeadlineFixture`: seed an open actor through the session's activity, then run each path. Assert `interrupted`, `terminalAt` set, counts `active 0 / done 1`, a journaled delta was published, and the final snapshot is Live with no active actor. A stream-end (crash) case does the same. |
| Interrupt mid-subagent with no `SubagentStop`; `task_notification(stopped)` before the mapping; hook dropped with 503 | `provider/claude/activity.rs` unit tests: turn-end close of a mapped foreground actor, late `SubagentStop` upgrading it to completed, an unmapped actor left open at turn end. `provider/claude/runtime.rs` unit test: the stopped notification is held, then applied when the mapping arrives. `tests/provider_claude.rs`: a fixture run where the stop hook never arrives (503) ends with the actor `interrupted` after the process ends. `hook_sink` unit test: a full channel answers 503 and counts the drop. |
| Conformance: "provider process ended with open subagent" for every chat provider | New `chat-process-ended-interrupts-active` scenario in `canonical-scenarios.json` with a repository checkpoint in `activity_provider_conformance.rs`. The path is provider-agnostic, so it drives Claude, Codex and OpenCode actors through the same projection helper. `every_canonical_scenario_has_a_repository_checkpoint` stays green. |
| Web: interrupted row (reason, last seen, under Done), explained no-target state, dock counts move | `activityPresentation.test.ts`: time labels per lifecycle. `ActivityRoster.test.tsx`: interrupted row under Done with its reason and "Last seen", and an active row with no target showing the description. `ActivityDock.test.tsx`: Active 1 / Done 17 becomes Active 0 / Done 18 on a snapshot change. |
| Client runtime: running → interrupted by delta and by replacement snapshot | `activityReducer.test.ts`: both cases. |
| Desktop e2e: interrupted by a session stop, leaves Active | `chat-activity-panel.e2e.ts`: new `it`. With the Codex fixture, the "Composer focus observer" child stays active (`test-project.ts:153-160`). The test dispatches `thread.session.stop` through a new `stopDesktopActivitySession()` export in `support/activity-session.ts` (`dispatchDesktopActivityCommands` is module-private). The step goes at the end of the existing `it` unless a second materialization with the fixed fixture ids is accepted. It asserts that the row leaves **Active**, reads Interrupted under **Done**, and shows the reason. Typecheck only for now. |
| Update maintenance | `production/runtime.rs` or `tests/`: `quiesce_for_update` with an open actor leaves it `interrupted`. A `prepare` with persisted running records completes without delay or failure. |
| Unchanged | The existing tests for `SubagentStop` completion, task-notification cancellation, targeted Stop, AI Terminal interruption, and the monitoring-disabled entry id stay green. |

## Gates

`cargo fmt --all --check`; `cargo clippy -p bibcode-server --all-targets -- -D
warnings`; focused `cargo test -p bibcode-server` (lib filters plus the
`activity_repository`, `activity_provider_conformance` and `provider_claude`
integration targets); `vp check --no-fmt` plus `vp check <changed files>`;
`vp run typecheck`; `vp test run --project unit` for the web and client-runtime
tests; `vp test run scripts/bibcode-identity.test.ts`. `vp run check:contracts`
is not needed because contracts don't change. Reviews: UI.md and
vercel-react-best-practices on `ActivityRoster` and `activityPresentation`.

## Profiler coverage

The change adds no child process, RPC, binary or worktree path. The new
interruption and hook-drop records are plain `tracing::warn!` lines with counts,
thread ids and hook event names only. No prompt or subagent text is recorded.

## Risks

- Shutdown under the update deadline: one read and one apply per session with
  open records, bounded by 128 records per batch. This is negligible next to the
  30 s deadline. Errors are logged, not returned.
- Codex resumption can re-report a child as running with a newer timestamp,
  which revives the record. That is truthful if Codex really reports it, and it
  is the known Codex recovery behavior. It is noted, not fixed.
- The turn-end close relies on correlator mappings. When a mapping is wrong, the
  correlator's poisoning already drops the mapping, so no close happens.

## Skipped (ponytail)

Skipped: a new lifecycle state, manual dismiss/archive, the client "No update
for X" label, a longer quiet cap while a subagent is open (the cap stays; the
record now closes), the hook timeout mismatch, and Codex/OpenCode terminal
observer teardown.

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
