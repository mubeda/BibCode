# Server-side refusal of `worktree.remove` while a session runs

Status: **Approved (yolo, lane manager) 2026-09-26**. A read-only Codex second opinion reviewed
it; its findings and the rulings are at the end.

This follows up b66e8c62, which stops the web from deleting a worktree while a session in it runs.
Only the web enforces that rule. Citations were checked against `dedda27d`.

## Problem and evidence

- **The web's rule.**
  - A card's **Delete Worktree…** is disabled, and so are the shared removal dialog's destructive
    buttons, while a session in that checkout is `running` (`isWorktreeSessionRunning`,
    `apps/web/src/components/Sidebar.logic.ts:730-747`).
  - The click path re-checks the local store (`WorktreeRemovalDialog.tsx`,
    `readWorktreeSessionRunning` and `executeDestructiveRemoval`).
- **The server's `worktree.remove` has no session guard.** It is registered at
  `apps/server/src/production/worktree_catalog_rpc.rs:773-803`, and `remove_worktree_owned` runs
  from `:1805`. It:
  1. resolves the owner and the project threads sharing the checkout (`resolve_removal_thread`,
     `:1993-2075`);
  2. marks the workspace as being removed (`mark_removing`, `:1842-1845`). New workspace
     admissions are refused from then on;
  3. builds and validates the plan (`:1846-1865`);
  4. quiesces (`:1876-1887`):
     - `removal_thread_ids` resolves every affected thread, across projects sharing the repository
       (`worktree_runtime.rs:1257-1302`);
     - it waits for in-flight workspace admissions to drain (`wait_for_removal_admissions`,
       `availability.rs:865-873`, called from `worktree_runtime.rs:~465`);
     - it stops each thread's provider session (`worktree_runtime.rs:1059-1086`) and closes its
       terminals;
  5. deletes the checkout (`:1927-1931`).
- **So a running turn is stopped and its checkout deleted whenever any client asks:**
  - an older web build;
  - a script;
  - two clients racing. The web's click-time re-check reads a store that lags the server.
- **`worktree.removeFromBibCode`** also stops sessions, and by the user's decision in b66e8c62 it
  stays allowed. Out of scope.

## Goals and non-goals

**Goals:**

- `worktree.remove` refuses with a typed `WorktreeRemovalError { reason: "session-running" }`
  while any thread the removal would stop has a projected provider status of `running` or
  `starting` and a live session held by the provider supervisor.
- A turn start or delivery racing the removal cannot slip past the refusal. The authoritative check
  runs after new admissions are refused and in-flight ones have drained.
- The web maps the typed reason to the existing sentence, and treats `starting` like `running`.

**Non-goals:**

- `worktree.removeFromBibCode`.
- Pending, queued or uncertain deliveries (see Decisions).
- Closing the pre-existing removal-fence gaps for supervisor paths that launch without a workspace
  admission (see Risks).

## Alternatives

**A. One check before `mark_removing`.** It races with a turn admitted in the window.

**B. One check right after `mark_removing`.** It still races: `mark_removing` drains
terminal-signal permits, not workspace admissions (second opinion 2). A delivery holding an
admission can move a session to `starting` or `running` after the check.

**C. An early check plus an authoritative check after the admission drain.**

- The early check, before `mark_removing`, refuses the common case without touching availability.
- The authoritative check first waits for `wait_for_removal_admissions`. New admissions are
  already refused, so no turn start or durable delivery can then begin in the checkout.
- It checks the same thread set the quiescer would stop, then either refuses or continues to the
  durable admission and quiesce as today.

**C′. C with a live-session gate (approved amendment, 2026-09-27).**

- Refuse only when the same thread has projected status `running` or `starting` and a live
  provider session. Fail closed with `session-running` if the liveness lookup fails.
- Workspace-loss cleanup and the user's Stop call `stop_session`, which does not settle the
  projected status. C therefore stranded deletion after the provider was already stopped.
- A live idle session still proceeds to removal's existing quiesce; a stale active projection
  without a live session no longer blocks deletion.

**D. Refuse inside the quiescer.** The quiescer also serves `removeFromBibCode`, which must keep
stopping sessions.

## Recommendation: C′

### Server (`apps/server/src/production/worktree_catalog_rpc.rs` and `worktree_runtime.rs`)

1. **A shared check, `ensure_no_running_session(repositories, quiescer, thread_ids) -> Result<(), Value>`.**
   - It collects the threads whose projected session (`get_thread_session`) is `running` or
     `starting`, returning immediately if none match.
   - It asks the quiescer's required `live_session_thread_ids` method about only those threads.
     `WorktreeRuntime` delegates through its actions to the provider supervisor's
     `capture_session_identity`: `Ok(Some(_))` means live, `Ok(None)` or `SessionNotFound`
     means absent, and other errors fail the lookup. The actions trait defaults to an error;
     the no-op quiescer explicitly returns no live threads.
   - If any candidate is live, or the lookup fails, it fails with
     `removal_error(WorktreeRemovalErrorReason::SessionRunning, "Stop the running session before deleting this worktree.", None)`.
2. **The early check** runs over `resolved.known_thread_ids` right after
   `resolve_removal_thread_with_ownership`, before `mark_removing`. It is skipped when
   `reservation.prepared_retry` is set: a prepared retry must reach the plan, where the exact
   bypass is known.
3. **The authoritative check** runs after `validate_git_removal_preflight`, before
   `prepare_worktree_removal_admission`, unless `resumed_git_success` holds:
   - it awaits `registry.wait_for_removal_admissions(&guard.identity())` under a bounded deadline.
     Use the quiescer's graceful timeout or a named 5 s constant. A timeout refuses with the same
     reason, because work in the checkout is still starting;
   - it builds the quiescer's request (`WorktreeRemovalQuiesceRequest::repository(guard.identity(), project_id, plan.repository_key, known_thread_ids)`)
     and resolves its threads with `removal_thread_ids`. Expose that as `pub(crate)` from
     `worktree_runtime.rs`, unchanged;
   - it runs `ensure_no_running_session` over them.

   The early return drops the `RemovalGuard`, which restores availability exactly as the existing
   preflight errors do, before any durable admission.
4. **The resumed-retry exception** is exactly the existing `resumed_git_success` predicate:
   prepared retry, delete mode, and a verified `missing-unregistered` plan. The checkout is already
   gone, and refusing would strand the durable detach. Accepted receipts still replay before any
   check (`:1784-1788`, `:1825-1829`), and the stale-registration cleanup of a missing checkout is
   unchanged.
5. **The Rust `WorktreeRemovalErrorReason`** (`worktree_catalog_rpc.rs:~1582`, serde kebab-case)
   gains `SessionRunning`, which serializes as `"session-running"`.

### Contracts (`packages/contracts/src/worktree.ts`)

- `WorktreeRemovalErrorReason` gains `"session-running"` (`:276-293`).
- Run `vp run check:contracts`, and commit the regenerated typed-failure fixtures and manifest
  fingerprints.
- An old client decodes the new literal as a failure and shows its generic removal failure. From
  b66e8c62 on, that client already disables Delete while a session runs.

### Client runtime

- `packages/client-runtime/src/state/worktrees.ts` already turns only `stale-plan` into
  `PlanChanged` (`:555-566`) and propagates every other reason.
- Add a test there (`worktrees.test.ts`, near the existing removal-failure cases ~`:1499`):
  `session-running` propagates as a failure and is never retried or reported as `PlanChanged`.

### Web

- **`WorktreeRemovalDialog.tsx`:** `failureMessage` maps a `WorktreeRemovalError` with reason
  `session-running` to the existing exported constant
  (`sidebar/sidebarMenus.logic.ts:51-52`, "Stop the running session before deleting this
  worktree."). Other failures keep their message.
- **`Sidebar.logic.ts`:** `isWorktreeSessionRunning` treats `starting` like `running`. Update the
  expectation in `Sidebar.logic.test.ts` (~`:1789`, currently `starting` = false).
  `isWorkspaceThreadRunning`, which drives the Working pill, is unchanged.

### Docs

- **`docs/architecture/rpc-and-orchestration.md`, "Worktree removal flow":** the refusal, its two
  checks, the admission drain and the resumed-retry exception.
- **`docs/user/workspace-ui.md`:** the server also refuses, and a `starting` session counts.
- **`docs/testing/cross-platform-validation.md`:** the existing removal-refusal step (~`:1988`)
  also covers the server refusal.

## Decisions

- **C′ live-session gate:** projected `running`/`starting` and supervisor liveness must both
  hold for the same thread. A stale projection alone does not prove removal would stop a
  running session; liveness alone would incorrectly refuse idle sessions. Lookup errors refuse
  because absence cannot be proven. Both check positions and the admission drain stay unchanged.
- **Pending, queued and uncertain deliveries do not refuse.**
  - After the drain, new admissions are refused, so no pending delivery can launch in the
    checkout.
  - The client deletes the thread after a successful removal, so admitted but unstarted work goes
    with it, which is what an explicit Delete asks for.
  - The refusal copy is about running sessions. A "message about to start" case would need its own
    copy for a race of milliseconds.
  - Cost if wrong: a message sent from one client at the exact moment another client deletes the
    worktree is discarded with the thread.
- **Session statuses:** `running` and `starting` refuse when the thread also has a live provider
  session. `connecting` is a web-derived phase, not a projected status (second opinion 3).

## Tests

- **Unit tests (`worktree_catalog_rpc.rs`):**
  - a live running owner session refuses with `session-running`; no plan admission, quiesce or deletion
    happens, and availability is restored;
  - a running session of another thread in the checkout refuses, and so does a thread of another
    project sharing the repository, when a seam allows it;
  - a live `starting` session refuses;
  - a live `ready` session proceeds, and removal stops it as today;
  - a stale `running` projection with no live session proceeds and deletes the checkout;
  - a failed liveness lookup for a `running` projection refuses;
  - **drain ordering:**
    1. hold a workspace admission on the thread through the availability registry;
    2. start the removal and observe that it waits at the drain;
    3. flip the session to `running`, then release the admission;
    4. the removal refuses;
  - an admission that never drains refuses at the deadline. Use a short test deadline through the
    existing options or a test hook;
  - a resumed retry after Git success completes even if a session row says `running`;
  - `removeFromBibCode` is unaffected.
- **Runtime actions (`worktree_runtime.rs`):** report only threads whose provider session identity
  can be captured; stopped or absent sessions are not live, and lookup errors propagate.
- **Contracts:** `WorktreeRemovalError` decodes with `session-running`, and the fixtures are
  regenerated.
- **Client runtime:** propagation, with no retry.
- **Web:** the dialog shows the mapped sentence for a `session-running` failure;
  `isWorktreeSessionRunning` is true for `starting`; the existing b66e8c62 tests stay green.
- **Live, on an isolated server with a fake provider holding a turn open:**
  - a scripted `worktree.getRemovalPlan` then `worktree.remove` while the turn runs returns the
    typed refusal, and the checkout still exists;
  - the dialog shows the mapped sentence when the server refuses. Trigger it with a second client
    starting the turn after the dialog's plan loaded, or with a request the web's own rule did not
    stop;
  - after the session stops, removal succeeds;
  - screenshots in light and dark.

## Risks

- **Pre-existing removal-fence gaps (not introduced here).** Some supervisor paths launch or
  restart without a workspace admission (second opinion 2):
  - recovery relaunch (`provider_runtime.rs:~1753`);
  - mode and model restarts (`:~3892`, `:~4122`);
  - detached delivery tasks (`:~3241`).

  A running session is refused before quiesce, and these paths mostly concern idle sessions, which
  removal already stops. A supervisor-level launch fence is a separate follow-up.
- **Stale projected status:** `stop_session` writes no projected status, so Stop and workspace-loss
  cleanup can leave `running` behind. C′ allows server removal once the supervisor has no live
  session; it does not repair the projection itself.
- **Follow-up: the web still uses projected status alone,** so Delete remains disabled in this
  stale state even though the server allows removal. A session's exit after workspace loss is
  not projected, a pre-existing gap that needs a separate follow-up.
- **An old client meeting the new literal** shows a generic failure.
- **The drain deadline refuses a removal while slow work holds an admission,** so the user retries.

## Second opinion (Codex, read-only) and rulings

1. **Current behavior:** agreed; the function starts at `:1805`. Fixed.
2. **The second check was not race-free:** `mark_removing` drains terminal signals, not
   admissions. Ruling: the authoritative check waits for `wait_for_removal_admissions`. The
   supervisor paths without admissions are recorded as pre-existing risks.
3. **`running` and `starting` only:** agreed.
4. **The exception must be the full `resumed_git_success` predicate,** which the pre-plan position
   could not know. Ruling: the authoritative check sits after the plan, and the early check skips
   prepared retries.
5. **Enum location and fixtures:** adopted.
6. **"Refuse pending and sending too":** declined, with the rationale under Decisions.
7. **Web:** adopted, reusing the already exported constant.
8. **Use the cross-project thread resolution, and test the ordering at the concurrency seam:**
   adopted.
