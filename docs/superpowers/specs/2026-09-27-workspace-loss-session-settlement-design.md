# Settle the provider session when a workspace loss stops it

Status: **Approved (yolo, lane manager) 2026-09-27**, after a read-only Codex second opinion (its
findings and the rulings are at the end). The controller approved the item and its direction:
settle the way restart reconciliation does, with one shared function, scoped to the stopped thread.

This was found while verifying item 03 (the `worktree.remove` refusal) on the host. Citations are
against `ed1e5de0`; `worktree_runtime.rs` lines may shift by item 03's uncommitted hunks.

## Problem and evidence

A workspace loss (the worktree directory disappears) quiesces the affected threads. When the
thread's provider session is running a turn, the session is stopped, but its projection keeps
saying `running` until the server restarts.

- **The loss path stops the provider.**
  - `ProductionWorktreeRuntimeActions::stop_provider` (`apps/server/src/production/worktree_runtime.rs:~999-1024`)
    captures the session identity, then calls `ProviderRuntimeSupervisor::stop_session_if_current`.
  - The supervisor's handler (`provider_runtime.rs:~2641-2657`) calls `stop_session` only when the
    captured driver is still current. It returns `Ok(())` in both cases, so the caller cannot tell
    whether anything was stopped.
- **Stopping projects nothing.**
  - `stop_session` (`:~5378`) runs `detach_session` (`:~5412`), which aborts the session's event
    task. So the pump never projects an exit.
  - It deletes the runtime row.
  - Session status changes only through `thread.session-set` (engine `apply_sessions_projector_tx`,
    `:~5863`). No production path projects a status after a stop.
- **Nothing else clears it.**
  - The loss handler only appends a `workspace-unavailable` activity (`worktree_runtime.rs:~1171`).
  - `thread.turn.interrupt` with no live session fails with `SessionNotFound` before any projection
    (`provider_runtime.rs:~3939`).
- **What the user sees once the workspace is restored** (the flow `tests/external_worktree_lifecycle.rs`
  exercises):
  - the thread shows Working forever;
  - new messages queue, because the phase stays `running`, and never promote: the session never
    reaches `ready`, and the turn row stays `running`;
  - Send now stays disabled with "Wait for the running turn to end";
  - Stop fails;
  - the web keeps Delete Worktree disabled.
- **Only a server restart clears it.** `reconcile_abandoned_provider_sessions` (`:~1852`) finds a
  projected `running` session with no live runtime row. `reconcile_abandoned_provider_session`
  (`:~1985`):
  - settles the abandoned turn's streaming assistant messages;
  - projects `error` with class `transport_error`, clearing the active turn;
  - the turns projector then marks the running turn `error` (`engine.rs:~5961-5969`);
  - it marks any runtime row `error`.

## Goals and non-goals

**Goals:**

- When a workspace loss stops a thread's live provider session and the projection is active
  (`starting`, `connecting` or `running`), the thread is settled at once by **the same function**
  restart reconciliation uses, with a loss-specific message.
- Settlement happens only for the session the loss actually stopped:
  - a session that was not current (for example a replacement) stays untouched;
  - a live session the loss did not stop stays untouched.
- Queued messages keep the queue feature's semantics (below).

**Non-goals:**

- `thread.session.stop` (the web uses it only when deleting a thread);
- the removal quiesce (the thread is removed right after);
- idle `ready` sessions: a stopped idle session is relaunched by the next send (the existing
  provider-loss relaunch), so it is not stuck;
- a periodic sweep for stale sessions;
- web changes: the web already follows the projected status.

## Alternatives

**A. Settle in `stop_provider` after `stop_session_if_current` returns `Ok`.** Racy. `Ok(())` also
means "not current", so a replacement session's projection could be overwritten.

**B. Stop and settle atomically in the supervisor (recommended).**

- A new supervisor method, `stop_session_for_workspace_loss(identity)`, sends the existing stop
  message with a settlement request.
- The handler settles only when it actually stopped the current session. It runs inside the
  supervisor's serialized loop, so no other command for that thread can interleave between the
  stop and the settlement.
- The settlement calls the shared function.

**C. Make every `stop_session` project a status such as `stopped`.** This changes thread delete,
removal and every stop path. `stopped` is not an error settle, so queued rows would not be held,
which diverges from the restart semantics the controller asked for.

**D. A periodic sweep for projected active sessions without a live runtime.** It is broader, but it
is timer-driven, races launches, and duplicates startup reconciliation's policy on a clock.

## Recommendation: B′ (B amended by the second opinion)

### Server (`apps/server/src/production/provider_runtime.rs`, a shared file: minimal hunks)

1. **One settlement function.**
   - `reconcile_abandoned_provider_session` stays the single function, and gains a
     `settled_at: String` parameter. It is used for the settlement events' timestamps and for its
     `projection_is_complete` check.
   - The restart path passes the value it uses today (the projected session's `updated_at`), so
     restart behaviour is unchanged.
   - The loss path passes the loss time.
   - No copy.
2. **The loss message:**
   `const WORKSPACE_LOSS_SESSION_ERROR: &str = "Provider session stopped because its workspace became unavailable. Review delivery status before continuing.";`
   The class stays `transport_error` (BiBCode stopped it; the provider did not fail).
3. **A supervisor operation, `settle_session_after_workspace_loss(thread_id, identity: Option<ProviderSessionIdentity>)`**
   (a new `SupervisorMessage` variant). It runs inside the supervisor's serialized loop:
   1. If `identity` is `Some` and still current, stop the session (`stop_session`: detach, shut the
      driver down, delete the runtime row). Keep the shutdown result to return later: a shutdown
      error must not skip the settlement, because the session is already detached.
   2. Then, if the thread has **no live session** in the supervisor, read its projected session. If
      its status is `starting`, `connecting` or `running`, call the shared function:
      - a `SessionInput` built from that projection, as restart's second loop builds it;
      - the thread's runtime row if one still exists (otherwise `None`);
      - the loss message and `settled_at` = the time the handler runs.
   3. After a successful settlement dispatch, wake the delivery worker (item 5).
   4. Return the shutdown error or the settlement error, if any.

   A live session that is not the captured one (a replacement) means the thread still has a live
   session, so nothing is stopped or settled. A projection that is not active is left alone.
4. **Late-acceptance fence.**
   - Today a spawned delivery task that gets `Accepted` persists runtime `running` and dispatches
     session state `running` (`provider_runtime.rs:~3385-3400`) without checking whether its
     session was stopped meanwhile. That can undo a settlement.
   - Clone the session's `event_cancellation` token into the task. Every cancel site means the
     session ended: stream end, detach, restart.
   - Skip the `running` runtime and session-state publication when the token is cancelled. The
     delivery outcome is still returned unchanged, so an accepted message is still recorded as
     delivered.

### Server (`apps/server/src/orchestration/engine.rs`)

5. **`pub(crate) fn wake_turn_delivery(&self)`** notifies the registered delivery waker (a no-op
   when none is registered).
   - An `error` session-set does not wake the worker today (`engine.rs:~2696-2701` wakes only on
     `ready`). A pending, non-queued start could otherwise sleep after the settlement.
   - The engine's wake rule itself is unchanged.

### Server (`apps/server/src/production/worktree_runtime.rs`)

6. **`ProductionWorktreeRuntimeActions::stop_provider`** (the loss path) keeps its
   `transition_is_current` checks, captures the identity as today, and then **always** calls
   `settle_session_after_workspace_loss(thread_id, identity)`, even with no live session.
   - This drops today's early return for `None`, so a later cleanup attempt of the same loss can
     retry a settlement that failed.
   - The removal path is unchanged.

### Queue semantics after settlement (document in `rpc-and-orchestration.md`)

- The `error` session-set holds every queued row and latches the hold on pending or sending steer
  rows. This is the existing rule for error settles.
- The queued head shows **Waiting for you**. **Send now** works once no running or starting
  session exists and the workspace admits work again.
- The settlement wakes the delivery worker, so a pending, non-queued start is re-examined:
  - while the workspace is unavailable, admission refuses and the delivery retries with backoff;
  - after recovery, it launches a replacement session (the existing provider-loss relaunch);
  - a retry that was bound to the stopped session's native identity can fail, because stopping
    deleted its resume state. This is pre-existing.
- The settled turn's streaming assistant text is kept, and the turn row ends as `error`.

## Affected files

- `apps/server/src/production/provider_runtime.rs`:
  - the new message variant and method, and the handler branch;
  - the constant;
  - the `settled_at` parameter;
  - the delivery-task fence;
  - a small new test module;
- `apps/server/src/orchestration/engine.rs` (`wake_turn_delivery`);
- `apps/server/src/production/worktree_runtime.rs` (one call site, plus tests);
- `docs/architecture/rpc-and-orchestration.md` ("Missing-workspace runtime guard", or the loss
  paragraph in the queue section);
- this design, at `docs/superpowers/specs/2026-09-27-workspace-loss-session-settlement-design.md`.

## Tests

**Supervisor seam** (fake drivers, a real engine), in a small new test module in
`provider_runtime.rs`:

- A running turn, then settle with the current identity:
  - the session is `error` with class `transport_error` and the loss message, with no active turn;
  - the turn row is `error`, and streaming messages are settled;
  - queued rows are held;
  - the delivery waker was notified.
- The driver's `shutdown` returns an error: the thread is still settled, and the error is returned.
- A replacement live session and a stale identity: nothing is stopped, and the projection is
  unchanged.
- No live session, and an active stale projection (a retry): settled.
- A live `ready` session: stopped, with no settlement (the projection stays `ready`).
- **Late acceptance.** A delivery whose driver returns `Accepted` after the session was detached
  publishes no `running` runtime or session state, and its delivery outcome is still `Accepted`.
- `stop_session_if_current` (the removal path) still settles nothing.
- The restart reconciliation tests pass unchanged (the same function, `settled_at` as before).

**`worktree_runtime.rs`:** the production loss action calls the settle operation even when the
identity is `None`. Use the real-supervisor harness item 03 added.

**Integration.** Run every binary that asserts on session projections or on the loss flow. Search
`apps/server/tests` for `thread.session-set`, `transport_error`, `workspace-unavailable` and
`stop_session`; at least `external_worktree_lifecycle`, `production_worktree_catalog_rpc`,
`production_provider_runtime`, `turn_delivery_recovery`, `turn_delivery_queue` and `orchestration`.

## Live check

Use an isolated stack with a fake Claude that holds a turn open, and the item 03 binary as
"before".

1. Start a turn in a managed worktree thread, and queue one message.
2. Make the worktree disappear (move its directory away), wait for the loss quiesce, then move it
   back.
3. Before: the thread still shows Working, the queued card's Send now stays disabled, and a new
   message only queues.
4. After (the fixed binary, same steps): the thread shows the loss error, Working is gone, the
   queued card says **Waiting for you** with Send now enabled, and Send now starts the turn in a
   replacement session. No restart is involved.
5. Take screenshots in light and dark.

## Risks

- **`provider_runtime.rs` is shared.** Keep the hunks small, and list them in the READY file.
- **A settlement failure** (for example the engine refuses the dispatch) is returned to the loss
  cleanup. Its next attempt retries, because the operation settles any active projection without a
  live session. Restart reconciliation still clears it later.
- **The late-acceptance fence** checks a token before publishing, so a check-then-publish window of
  microseconds remains. Routing every delivery publication through the supervisor would close it,
  and was declined as disproportionate.
- **The error class `transport_error`** reuses the restart meaning ("BiBCode stopped it"). The
  message text tells the two apart.

## Second opinion (Codex, read-only) and rulings

1. **Evidence:** agreed. Interrupt can commit queue holds before routing fails, which does not
   change the fix.
2. **No deadlock, but "atomic" was overstated:** late delivery publications can re-project
   `running`. Ruling: add the cancellation-token fence (item 4). Routing all publications through
   the supervisor was declined (disproportionate); the residual window is recorded.
3. **Parameterize the settlement time:** adopted (`settled_at`). Restart keeps its policy.
4. **An error settle does not wake the worker:** adopted (`wake_turn_delivery` after settling). The
   pre-existing session-bound retry failure is recorded.
5. **Ready sessions:** agreed; no settlement.
6. **Exclude removal and graceful shutdown:** agreed. The failed or cancelled removal quiesce and
   the idle-suspension ordering are follow-ups outside this item.
7. **Don't condition settlement on `stop` returning `Ok`; keep retry ownership:** adopted. The
   operation settles whenever no live session remains and the projection is active, and the loss
   action always calls it.
