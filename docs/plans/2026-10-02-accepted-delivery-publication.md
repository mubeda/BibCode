# Proposed narrow design for issue #32 — accepted delivery publication ordered with stop

Status: approved by the user on 2026-10-02. Implement accepted-delivery publication through the existing supervisor actor, with the trade-offs and failure semantics below. No implementation had started when approval was recorded. Source references were inspected on the shared working tree; central function positions still match baseline cd66fda57. Parent may recheck positions after other issue commits.

## Problem and invariant

`spawn_delivery` (provider_runtime.rs:3943) runs the provider `deliver` in a detached Tokio task. At :4062 it checks the event cancellation token once; then awaits `persist_runtime(..., running)` and `dispatch_session_state(..., running)`. `SettleSessionAfterWorkspaceLoss` (:3228) independently stops the driver, deletes runtime, reads projection, and reconciles active statuses. Passing the cancellation check before detach lets accepted writes resurrect the deleted runtime row or settled projection after settlement returned.

Required invariant: when settlement returns, a delivery belonging to the removed driver cannot subsequently publish runtime or session state. If delivery publication wins ordering, settlement follows and reconciles it. If stop/settlement wins, publication is suppressed. Preserve provider Accepted outcome: suppressed local publication does not mean the provider never received the message. Replacement-driver state must be untouched by stale driver publications.

## Recommended design: publish accepted starts inside existing supervisor actor

Keep delivery I/O in its existing detached task. Move only the two accepted-start durable writes into a new private actor message handled by `run_supervisor` (:3057), alongside stop and settlement. Reuse exact `ProviderSessionIdentity` (thread + Arc driver identity), add current delivery `generation`, accepted `turn_id`, and a oneshot acknowledgement. Do not send command bodies, attachments, provider credentials, launch routes, or runtime payload copies in this message. Retrieve current launch/resume/runtime payload from the identity-matched `SessionEntry` inside the actor.

Proposed flow:

1. `Deliver` (:3318) admits a single active generation for that thread. It invokes spawn_delivery, which returns a handle immediately; then records `ThreadDeliverySequence.active_generation` (:3404 onward). It does not await the detached delivery's completion.
2. Detached task still freezes durable identity and awaits driver delivery exactly as today. For `Accepted` start only (never steer), send `PublishAcceptedDelivery { identity, generation, turn_id, acknowledgement }` through the existing internal terminal/control channel. Await acknowledgement before calling `DeliveryTerminalGuard.complete()` and fulfilling caller completion. Both success and suppressed publication acknowledge; write errors retain today's warning and Accepted outcome. No retry/redelivery is introduced here.
3. Actor handles the message only if current session driver's Arc matches identity, event cancellation is not set, and current active delivery generation matches. These checks fence replaced sessions, detached sessions, terminally settling sessions, and stale same-driver deliveries. Otherwise acknowledge suppression without any DB write.
4. Actor performs persist_runtime and dispatch_session_state sequentially while remaining the sole owner of session lifecycle. It does not poll a second control message during these awaits. No stop or settlement handler can detach/reconcile this driver between the two writes. Therefore every earlier accepted publication is complete before a later stop/settlement reads/reconciles state; every publication dequeued later sees no live matching entry.
5. The delivery terminal guard then sends existing DeliveryComplete (:3632), which clears the generation and drains deferred provider configuration/stop. Abnormal task exit still triggers Drop's abnormal completion (:685). The publication message MUST precede guard completion; otherwise generation check would reject legitimate writes.
6. If actor channel/ack closes during shutdown, preserve Accepted as today and let terminal guard retire locally; do not synthesize DefinitelyNotSent. Shutdown has already detached all sessions and closed actor state ownership. Log or quietly treat closure according to existing shutdown conventions.

Use a helper for the accepted-write operation called by actor; do not create another independently mutable session owner, persisted generation schema, or protocol field. Any helper must receive actor-verified current entry data and not re-open publication off actor later.

## Why the existing actor can host this

- Controls already serialize launch, stop, removal suspension, workspace-loss settlement, configuration, and shutdown in one `run_supervisor` match. `sessions` has one mutable owner.
- Exact Arc driver identity is already used in StopSessionIfCurrent and workspace settlement, so no new source of truth.
- ThreadSessionSet is a simple orchestration event in engine.rs:4359, not a provider dispatch. Engine project effects cover project operations; accepted running session-set does not recurse into a supervisor command. This is the critical no-cycle boundary to preserve.
- DeliveryComplete uses priority unbounded terminal channel already. Supervisor queue capacity defaults to 32 (:110/:412); receiver is bounded, terminal channel is existing unbounded lifecycle/control lane (:834-835), and `tokio::select! biased` receives terminal first (:3086).
- `SessionStreamEnded` on that priority lane waits at most PROVIDER_STREAM_SETTLEMENT_TIMEOUT before retaining a pending projection fence (:3294). PublishAcceptedDelivery must skip event-canceled/pending-stream-settlement state so it cannot replace an already-visible terminal error.

## Deadlock, queue, and performance constraints

Do not move driver.deliver itself into the actor. Native delivery may await provider callbacks and must remain independent of actor controls. Do not await Publication while actor is awaiting that detached delivery; current Deliver only returns its handle, so no cycle arises. Do not make the event pump await this new actor message: detach currently cancels/aborts/joins event_task (:6511 onward), which would otherwise create a self-join cycle. The new publication origin is only the detached delivery task, whose driver.deliver has already returned.

Use existing internal terminal lane for a single compact publication per accepted start generation; no new unbounded data lane or per-delta message. Active deliveries are already bounded by service permits and one active generation per thread; direct supervisor callers retain existing admission behavior. Pair its acknowledgement with DeliveryComplete so queued configuration never overtakes publication. Trace and test driver.shutdown against an already-returned deliver to confirm no driver-specific join dependency on the outer detached task.

Two additional DB/engine awaits become actor work. This introduces temporary head-of-line blocking of unrelated thread controls, but these writes already execute on bounded DB/engine workers and other actor paths already await the same persistence/projection operations. Preserve that limitation explicitly; do not bolt on a timeout that lets mutation continue after actor moves on, since a late commit would recreate the same race. A future bounded per-session publication owner is a separate architectural optimization if measurement shows this control latency is material. No global mutex or lock held across all unrelated-session I/O is added beyond the actor's existing ownership model.

Event-pump projection remains independent. Detach already cancels/aborts/joins the event pump before settlement; this proposal addresses the late detached delivery publication gap specifically. Tests must establish that existing event-pump cancellation/commit semantics remain safe; if investigation finds a durable engine write survives event-pump join, expand design before claiming the broader invariant. The accepted-vs-fast-turn-completion ordering is pre-existing and should be regression-tested; the narrow #32 fix must not introduce a new overwrite of a completed turn.

## Alternatives considered

A. Add more token checks before/after each awaited write. Smaller patch but rejected: each check still has a check-to-commit race, and a postwrite correction can overwrite a replacement session. Does not satisfy invariant.

B. Per-session async publication fence shared by delivery and detach, close and await all admitted writers before settlement. Avoids actor head-of-line blocking and can cover event pump, but adds new ownership/lease state, a closure-and-drain policy, cancellation-safe release, and deadlock ordering across event-task abort and shutdown. Requires broader testing and bounded cleanup design. Reasonable future alternative if actor latency matters; unnecessary for narrow accepted-write gap.

C. Persist runtime-generation CAS in SQLite/session projection. Strong durable guard across restarts but changes schema/event projection/public invariants and still needs lifecycle-safe generation invalidation. Too broad for this issue.

D. Serialize accepted publication through existing actor (recommended). Reuses identity and session state ownership; closes both writes against settlement deterministically. Tradeoff is small extra actor persistence latency.

## Deterministic regression plan

- Before fix add test-only checkpoint after current acceptance cancellation test and before persist_runtime. Block there, call settle_session_after_workspace_loss and wait until it returns, unblock publication. Red: running/runtime row resurrects. Fixed seam should pause accepted publication before actor enqueue, settle first, then release; no runtime row and projection remains settled error after Accepted result.
- Test publication already admitted/processing, then request settlement. Hold actor write/projection checkpoint, assert settlement cannot finish while write is in progress; release, settlement runs next, final status error/no live driver/no runtime row. Avoid sleeps: explicit notifications/oneshots and awaited actor responses.
- Repeat race with previously ready projection, running active turn, and shutdown failure; no common-case regression. Preserve partial assistant text and held FIFO delivery behavior.
- Detach/launch replacement before releasing stale publication; ensure replacement projection/runtime are unchanged. Check same-driver wrong delivery generation is suppressed.
- Accepted steers continue to avoid session running publication entirely.
- Publication acknowledgement/actor shutdown failure must not turn Accepted into not-sent or hang completion. Deferred config/explicit stop still drain only after publication+DeliveryComplete.
- Existing workspace_loss_tests acceptance_after_detach_does_not_publish_running_state (:2495) remains but is insufficient alone; run all workspace-loss tests plus stream-end, idle, provider delivery, turn recovery, and worktree runtime loss integrations.

Expected focused command: `cargo test -p bibcode-server --lib production::provider_runtime::workspace_loss_tests:: -j 2`; adjacent provider supervisor tests and `--test production_provider_runtime --test turn_delivery_recovery` afterward.

Docs in issue commit: rpc-and-orchestration workspace loss paragraph currently promises only one token check; describe actor identity/generation ordering and Accepted outcome preservation. Providers lifecycle and native cross-platform workspace-loss procedure must match. No schema/fixtures/web UI change necessary for #32.

## Approved amendment, 2026-10-03

The user approved all pending designs, selecting the recommended per-session
publication fence from `issue32-revised-design.md`. This amendment supersedes the
actor-only policy above. That prototype fixed workspace-loss ordering but a
controlled normal-completion regression still ended Running after a visible
Ready. The original RED evidence and workspace-loss tests are retained outside
the repository; the copied legacy comparison branch and temporary lint allowance
are removed from the maintained implementation.

Each SessionEntry and its existing event pump share one private async mutex with
closed state and a monotonically increasing terminal revision. The actor remains
the sole owner of driver identity, Accepted generation and acknowledgement. Both
durable and legacy start admission capture the revision before native I/O, and
both optimistic Running writes use one lease that checks closure and that
witness. Any terminal since admission suppresses the writes, including an
unknown native turn ID or a late previous-turn terminal. A fresh admission can
publish at the newer revision; exhaustion is absorbing and never wraps.
Suppression preserves Accepted and never redelivers or interrupts native work.

The pump advances the revision before a terminal write and holds one lease
through the complete core event batch, including existing partial-message retry
policy and terminal activity. Other core events preserve sequential pump order.
Native next_event, driver controls, activity projection/control acknowledgements,
idle scheduling, actor acknowledgement and native shutdown run outside that
lease. EOF retains its existing SessionStreamEnded/settled protocol, using the
fence for the active-turn read and final synthetic terminal batch.

Detach removes actor admission, cancels the event token, then closes and drains
admitted submitted writers before abort/join or runtime deletion. Successful
restart uses that same helper and a fresh replacement fence after native shutdown;
shutdown failure returns before removal, preserving existing behavior. No drain
timeout is permitted to report successful settlement with a live admitted writer.
This guarantees supported cancellation/stop/restart/shutdown ordering, not crash,
panic, worker failure recovery or a bound on OS/DB completion time.

Alternatives: moving normal terminal batches to the actor would add a pump-to-
actor acknowledgement dependency while actor-held native controls can depend on
bounded output consumption; eliminating that cycle requires a broader native
control continuation design. A durable CAS would change schema/projector
semantics and still require writer drain. The approved fence adds one
uncontended mutex acquisition per core event and constant per-session state,
with no queue, new task, native transport, engine/database semantics or public
contract change. An admitted writer can delay lifecycle controls until it
finishes, while unrelated pumps remain independent.

Deterministic acceptance covers both Accepted/terminal orders, complete-batch
admission and delta ordering, known/unknown/failed terminal results, a real
submitted persistence operation during detach/restart, closed stale writers,
fresh replacement and failed shutdown, revision exhaustion, bounded native
output during actor controls, plus existing acknowledgement/steer/EOF/idle
controls. Living providers and cross-platform validation documentation describe
the maintained implementation.
