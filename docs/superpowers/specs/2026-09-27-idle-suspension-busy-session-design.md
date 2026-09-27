# Idle suspension never suspends a busy session (F23)

Status: **Approved (yolo, lane manager) 2026-09-27**, amended after a read-only Codex second opinion
(its findings and the rulings are at the end), and after the implementation review (the
compare-exchange re-arm). This is item 06 of addendum 2. Citations are against
`57d9710e` (`apps/server/src/production/provider_runtime.rs` unless named otherwise).

## Diagnosis

**The idle deadline is armed after the completion becomes visible.**
- The event pump arms the idle timer only after `project_provider_event(turn.completed)` returns
  (`~5360-5380`). `schedule_idle_suspend` takes its generation with `fetch_add` at arm time (`~5501`).
- For `turn.completed`, `project_provider_event` (`~5525`) persists and projects `ready` first
  (`persist_runtime`, then `dispatch_session_state`). Only then does it settle streaming assistant
  messages and append the `turn.completed` activity: more engine round trips before it returns.

**A queued send can be admitted in that window.**
- The engine wakes the turn-delivery worker when it commits `thread.session.set` with status `ready`
  (`orchestration/engine.rs:~2707-2752`).
- The worker admits the next send: `SupervisorMessage::Deliver` (`~3313`) → `spawn_delivery`, which
  bumps `idle_generation` (`~3940`) and sets `active_generation` (`~3413`).
- The pump then arms with a newer generation, so the timer is current for the new turn.

**`SuspendIdle` checks only that generation** (`~3705-3715`). If the new turn is still running one
idle timeout later (60 s, `DEFAULT_SESSION_IDLE_TIMEOUT`), `suspend_idle_session` runs:
- `detach_session` cancels and aborts the event pump;
- the driver is shut down mid-turn;
- the runtime row is persisted as `suspended`.

No turn completion is ever projected, so the thread is left showing a running turn that no process
serves. The red test records the exact state at the base.

**The trigger is ordinary:** a queued message delivered when a turn completes (the message queue)
whose turn runs longer than a minute. The window is several engine round trips wide.

**Item 05 already has the right check,** inline in `SuspendSessionForRemovalIfCurrent` (`~3187-3222`).
- It reads the supervisor's `delivery_sequences[thread].active_generation`, the projected session
  status (not `running` or `starting`), and `active_turn_id`.
- The ordering makes it gap-free:
  - `Deliver` sets `active_generation` in the same supervisor message that bumps the generation;
  - the delivery task projects `running` before it sends `DeliveryComplete`, which clears it.
- So, at every point in the supervisor's serialized order, an admitted or accepted delivery is
  visible as either an active generation or a running projection.

## Alternatives

**A. Refuse at fire time, and re-arm.** `SuspendIdle` suspends only when the generation is current
**and** the session is confirmed idle, using item 05's predicate extracted into one helper. A
current deadline that meets a busy session re-arms itself for another idle timeout.
- It covers every path that makes a session busy, whatever the order of generation bumps.
- It costs one projection read per fired deadline, inside the supervisor loop. The read happens only
  when no delivery generation is active.
- Why re-arm instead of dropping the deadline: an admitted delivery can end `Rejected`,
  `DefinitelyNotSent` or `Ambiguous` without a turn. Then no completion ever arms a new deadline,
  and a dropped one would leave the session live forever.

**B. Take the generation before projecting the completion.** The pump would reserve the deadline's
generation before `project_provider_event`, so any send admitted after the `ready` projection makes
that deadline stale.
- It fixes this ordering at its source.
- It does not protect against any other way a current deadline can meet a busy session.

**A + B (chosen).**
- B closes the ordering, including the completion's own settlement window, which A alone leaves
  open.
- A keeps "never suspend a busy session" explicit, and independent of how the generations are
  counted.

## Recommendation: B, plus A as the explicit guard (amended by the second opinion)

A alone has a hole (second opinion, finding 1).
- A current deadline, whether raced or re-armed, can fire after the next completion projects
  `ready`, but before the pump has settled that turn's streaming messages and appended its final
  activity.
- The predicate then sees an idle session, and `detach_session` aborts the pump mid-settlement.
- So the ordering must be fixed at its source (B), with A kept as the explicit guard.

1. **Reserve the completion's deadline before `ready` is published (B).**
   - For every `turn.completed` event, failed or not, the pump takes the next idle generation
     **before** `project_provider_event`.
   - After a successful projection of a turn that did not fail, it arms the deadline with that
     reserved generation. `schedule_idle_suspend` no longer takes a generation of its own.
   - Every pending deadline therefore becomes stale before `ready` can admit a send, and before the
     settlement window opens. A send admitted after `ready` bumps past the reserved generation.
   - A failed turn still arms nothing, as today, but its reservation retires pending deadlines.
     This includes the synthetic failed completion that the pump projects when a stream ends.
2. **One shared predicate (A).** Extract `session_is_confirmed_idle(repositories,
   delivery_sequences, thread_id) -> Result<bool, ProviderRuntimeError>` from the removal arm.
   - It checks `active_generation` first, a map lookup, and returns before reading the projection.
   - The removal arm keeps its exact policy: the identity check, stop when busy or when the
     projection is missing, and propagating a read error.
3. **`SuspendIdle`** does this, in order:
   - stale generation: drop;
   - otherwise, evaluate the predicate, then **re-check the generation after the awaited read**,
     because the pump bumps it outside the supervisor loop;
   - still current and confirmed idle: suspend, as today;
   - still current and busy, or the read failed (warn): re-arm with a fresh generation, using the
     entry's `terminal_sender`, `idle_generation`, `idle_timeout` and test observer.
     - The re-arm reserves `generation + 1` with a compare-exchange from the deadline's own
       generation. If the pump has reserved a completion in the meantime, the exchange fails and
       nothing is armed, so a re-arm can never supersede a completion's reservation.
     - The observer reports `IdleDeadlineEvaluation::Busy`, then the re-arm's `Armed`, or `Stale`
       when the exchange failed;
   - stale by the re-check: drop.
4. **What this guarantees.**
   - A deadline never suspends a session with an admitted delivery or an active turn, or during a
     completion's projection. Exception: the residual paths below that make a session busy
     without projecting it.
   - A busy session is re-checked once per idle timeout. The next completion's reservation
     supersedes that re-check.
5. **Docs.**
   - `docs/architecture/providers.md`, beside the idle-suspension mention:
     - the deadline is reserved at completion, before `ready`;
     - a busy session re-arms immediately;
     - the next completion supersedes the re-arm.
   - `docs/testing/cross-platform-validation.md`, under "Durable message queue": one lifecycle
     case. A queued message is delivered at completion, and its turn runs past the idle timeout;
     the session must stay live until one timeout after that turn completes.

## Tests

In the supervisor test module, next to
`completed_idle_session_is_suspended_without_losing_resume_state`, which must stay green unchanged.
Its generation numbers are unchanged by B.

**Seam preconditions (second opinion, finding 4).** The engine's
`test_hooks().pause_before_next_command_persist()` is unfiltered and take-once. So:
- await the streaming `content.delta`'s persistence first;
- then install the first pause and emit the completion;
- install the second pause before releasing the first;
- keep every other command producer absent.

The first pause catches the `ready` session-set. The second catches the pump's next command, from
`settle_streaming_assistant_messages`.

The follow-up is sent with `deliver_turn`:
- It must carry **no `modelSelection`**. Otherwise the `Deliver` arm's `reconcile_model_selection`
  would dispatch to the paused engine and deadlock.
- Await its handle, then release the engine, then await its completion.

Tests are current-thread with paused time unless stated otherwise. Assert behaviour first, with
messages that make the base failure self-explanatory. Assert generation numbers only afterwards.

1. **A send admitted between `ready` and the arm.**
   - Hold the pump with the two pauses, admit the follow-up, release it, and let the delivery be
     accepted and projected `running`.
   - Advance by the timeout: no suspension. The deadline is `Stale`, the session is live, there are
     0 shutdowns, and the runtime row is not `suspended`.
   - Then complete the follow-up: a new `Armed`, and `Suspended` one timeout later, with the cursor
     kept.
   - Red at the base: `Suspended` mid-turn. Record what the projection and the runtime row show
     then.
2. **The same, with the delivery still in flight when the deadline fires.** The fake driver's
   `send_gate` holds it, so `active_generation` is set and the projection is still `ready`. No
   suspension. Release it, complete it, and it is suspended one timeout later.
3. **A deadline firing during a completion's settlement window.**
   - Create the raced deadline as in test 1, without advancing time.
   - Complete the follow-up, holding its pump after its `ready` projection with the two-pause
     technique.
   - Advance so that the raced deadline fires while the settlement is held: no suspension.
   - Release it: the streaming assistant message is settled, then the completion's deadline
     suspends one timeout later.
   - This is red at the base, and red for an A-only fix.
4. **A current deadline meeting a busy projection without a generation bump** (the explicit
   guard).
   - After a completion arms its deadline, dispatch a `thread.session.set` `running` with an active
     turn directly through the engine. This is the shape of the residual paths.
   - Advance: `Busy`, then a re-armed `Armed`, and the session is live.
   - Dispatch `ready` with no turn. Advance: `Suspended`.
   - Red at the base.
5. **Natural race probe** (multi-thread, real time, a 1 s timeout, no pauses).
   - Turn 1 is a real `deliver_turn`, so its projection goes `running`, then `ready`.
   - A watcher waits for that turn's own `running` → `ready` transition, not launch's `ready`, and
     admits the follow-up at once, as the delivery worker does.
   - Await the completion deadline's evaluation instead of sleeping, and assert that it is not
     `Suspended` while the follow-up runs.
   - A deadline that legitimately fires before the admission is a missed window. It passes, and
     prints `F23-PROBE missed-window` so the stress loop can count it.
   - It is racy at the base, and passes in every interleaving after the fix.

6. **The re-arm helper.** It reserves `expected + 1` while the generation is unchanged, and returns
   nothing, leaving the value alone, once a completion has reserved.

A read-error refusal is not tested: making the projection read fail would need a new production
failpoint, so it is out of proportion.

## Residual risks (predate this item; recorded, not fixed)

- **Liveness exclusions** (second opinion, finding 2):
  - A send admitted after the completion's deadline makes it stale. If that send ends without a turn
    (rejected, not sent, refused), no completion arms another deadline, so the idle session stays
    live until the next turn or a stop.
  - A launched or restored session that never runs a turn is never suspended.
  - A failed turn arms nothing.

  All three are today's behaviour. Arming at non-turn delivery outcomes would be a separate change.

- **An `Ambiguous` outcome where the provider did start a turn.** The projection stays `ready`, the
  generation is cleared, and a deadline can suspend it mid-turn. The queue's reconcile path owns
  that case.
- **A delivery whose `dispatch_session_state(running)` fails.** The turn runs but projects as idle.
  This is the same class of risk.
- **A provider that starts a turn on its own.** `turn.started` is only an activity, so the projection
  stays `ready`.

## Measurement

- Codex runs in two sequential jobs: 6a adds the tests only (red), then 6b adds the fix and the doc.
- Build the host lib test binary after 6a (the base plus the tests) and again after 6b.
- Run the natural probe N times under parallel load (provider-misc's stress runner pattern).
- Report x/N red at the base and 0/N fixed, with missed windows counted separately.
- Also report the deterministic tests red at the base and green after.

## Second opinion (Codex, read-only) and rulings

1. **Blocker: A can suspend during a completion's settlement window.** Adopted: B reserves the
   deadline before `ready`, the generation is re-checked after the awaited read, and test 3 pins it.
2. **Liveness:** recorded as existing exclusions (see Residual risks). Re-arming happens once per
   timeout, and the docs say so.
3. **The diagnosis is confirmed.** At the base, the thread stays projected `running` with its active
   turn, and only the runtime row becomes `suspended`. "Never" is qualified by the residual paths.
4. **Pause preconditions:** adopted verbatim in the Tests section.
5. **Red tests:** `Busy` is added in the tests-only job. The fake's `send_gate` covers a delivery in
   flight. A rejected delivery's liveness is an exclusion, so it is not tested. A read-error test
   needs a production failpoint, so it is declined.
6. **The natural test is a qualified probe:** it counts missed windows, waits for completion-specific
   readiness, and awaits the evaluation.
7. **Keep the removal policy exactly.** Adopted, with docs in `providers.md` and the runbook
   lifecycle case.

## Implementation review (lane manager)

The implementing job reported one residual risk, and it was confirmed.
- The busy re-arm took its generation with `fetch_add`.
- Between the post-read re-check and that `fetch_add`, the pump can reserve a completion's
  generation.
- The re-arm then superseded it, and could fire during a completion settlement held longer than the
  timeout.

Ruling: re-arm with a compare-exchange from the deadline's own generation, pinned by a helper test.
