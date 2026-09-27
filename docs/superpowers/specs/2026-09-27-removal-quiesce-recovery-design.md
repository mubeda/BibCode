# A removal that fails after the quiesce leaves nothing lost

Status: **Approved (yolo, lane manager) 2026-09-27**, after a read-only Codex second opinion (its
findings and the rulings are at the end). This is item 05 (F22) of addendum 2. Citations are against `65751d75`.

## Diagnosis

`remove_worktree_owned` (`apps/server/src/production/worktree_catalog_rpc.rs`, from `:~1810`) runs,
in order:
1. ownership and the early session check;
2. `mark_removing`;
3. plan and preflight;
4. the authoritative session check (item 03);
5. `prepare_worktree_removal_admission`;
6. **the quiesce**;
7. `verify_prepared_worktree_removal_admission`;
8. a cancellation check;
9. `resolve_trusted_repository_anchor` and its repository-identity check;
10. `apply_git_removal`;
11. `persist_detach`;
12. `commit_detached`.

**Steps 7-11 can fail after the quiesce:**
- the admission re-verify;
- a cancellation. The RPC's cancellation token (an interrupt, or the socket closing) aborts the
  removal after the quiesce;
- an anchor that resolves to another repository;
- `apply_git_removal`. In delete mode, any Git failure (a locked file, permissions, a hook) is
  returned as an error;
- `persist_detach`. This one runs after Git succeeded, and the prepared retry recovers it.

**What the quiesce did** (`WorktreeRuntime::quiesce_removal`, `worktree_runtime.rs:~418-470`;
production actions `:~1059-1141`), for every affected thread:
- `stop_provider_for_removal`: it captures the identity, then `stop_session_if_current` →
  `stop_session` (`provider_runtime.rs:~5961`). That detaches the session, shuts the driver down,
  and **deletes the provider runtime row**.
- `close_terminals_for_removal`: the terminal quiesce kills terminal processes and keeps their
  history.

**What the user is left with when a later step fails:**
- **Nothing busy.** Item 03 refuses removal while a live session is `running` or `starting`, after
  the admission drain. So the quiesce stops only idle, live sessions, whose projection stays
  `ready`. Availability is restored when the `RemovalGuard` drops. The queue is untouched.
- **Something lost, for a worktree that still exists: the provider conversation.** The runtime row
  holds the resume cursor. `launch_request_for_command` reads it (`provider_runtime.rs:~2080-2110`).
  With the row deleted, the next message silently starts a **fresh provider conversation**, so the
  agent forgets the thread's context. A durable turn frozen to that native session fails outright
  ("durable turn requires resumable runtime state"), which is item 07.
- **Terminal processes are gone.** They must stop before the checkout can be deleted, so this is
  inherent. Their history is kept, and they can be restarted.
- **Stale state.** Item 03's live-session gate can let a removal proceed over a stale active
  projection with no live session. The quiesce does not change that projection (nothing is live),
  so a failure leaves it as it was, and the removal does not cause it.

## Goals and non-goals

**Goals:**
- A removal that fails or is cancelled after the quiesce loses nothing that can be kept: the next
  message resumes the same provider conversation.
- Failures that can be checked before destroying anything are checked before the quiesce.
- A successful removal leaves no orphaned runtime state.

**Non-goals:**
- restarting killed terminal processes;
- item 07's frozen-delivery retry policy;
- the workspace-loss path (item 04);
- `worktree.removeFromBibCode`, beyond sharing the quiescer.

## Alternatives

**A. Move fallible work before the quiesce.** The anchor resolution and a first cancellation check
are read-only and can run before it. The admission re-verify must stay after the quiesce (it guards
the quiesce window), and Git removal must come after it. So this narrows the window, but it cannot
remove it.

**B. Suspend instead of stop in the removal quiesce.**
- The supervisor's existing idle suspension (`suspend_idle_session`, `provider_runtime.rs:~5980`)
  detaches, shuts the driver down, and persists the runtime as `suspended`, keeping the resume
  cursor.
- Item 03 guarantees that the sessions reaching the removal quiesce are idle, so suspension is
  valid.
- On failure, the next message resumes the conversation.
- On success, the removed threads' runtime rows must go, so none is orphaned.

**C. Settle what the quiesce stopped, reusing item 04's path.** There is nothing to settle: the
stopped sessions were idle, and their projection is honestly `ready`. Settlement would not restore
the lost resume cursor.

**D. Snapshot the runtime rows before stopping, and restore them on failure.** It needs explicit
restoration on every failure return, and it keeps the destructive step. It is more code than B for
the same result.

## Recommendation: B, plus an early cancellation check (amended by the second opinion)

1. **Cancellation.** In `worktree_catalog_rpc.rs`, check `cancellation` **before** the quiesce as
   well, so a request already interrupted destroys nothing. Keep the post-quiesce check.
   - Keep `resolve_trusted_repository_anchor` after the quiesce. Planning already validates the
     anchor before the quiesce, and an existing test removes the selected anchor during the quiesce
     and requires it to be selected again.
2. **Suspend for removal** (`provider_runtime.rs`, minimal hunks). Add a supervisor operation
   `suspend_session_for_removal_if_current(identity)`:
   - it is **confirmed idle** only when the thread's projected session is not `running` or
     `starting` (and has no active turn) **and** the supervisor has no active delivery generation
     for it (`delivery_sequences` / `active_generation`). There is no existing predicate for this;
     `suspend_idle_session` does not check idleness;
   - if the identity is current and the session is confirmed idle, run `suspend_idle_session`,
     which persists `suspended` with the resume cursor, using the guarded write (item 4);
   - if the identity is current but not idle, run `stop_session` as today. This happens with
     `removeFromBibCode` (which may stop running sessions by design) or a prepared post-Git retry.

   `stop_provider_for_removal` (`worktree_runtime.rs`) calls it instead of `stop_session_if_current`.
   The foreground quiesce and the reaper's retries both go through that action, so both preserve.
3. **Cleanup at thread deletion** (`orchestration/engine.rs`, plus `persistence/repositories.rs`
   if needed). Both removal RPCs tombstone the owner and its panels through
   `WorktreeDetachResolved` → `thread.deleted`; the web never calls `thread.delete` after a removal.
   In the shared `thread.deleted` transaction, delete the deleted thread's `provider_session_runtime`
   row, whatever its status. Threads that are not deleted, such as another project's alias of the
   same checkout, keep theirs.
4. **Guarded suspension write.**
   - The suspension's runtime write must not recreate a row for a thread that has been deleted,
     because a reaper retry can run after the commit.
   - Use an atomic conditional write, "insert or update only while the thread exists and is not
     deleted", for the suspension path.
   - A refused write means the thread is gone: nothing to preserve, and not an error.
5. **Docs** (`rpc-and-orchestration.md`, "Worktree removal flow"):
   - the early cancellation check;
   - suspension of confirmed-idle sessions during the removal quiesce;
   - the runtime cleanup at thread deletion;
   - what a failure after the quiesce leaves: idle sessions resumable, terminals closed with
     history kept;
   - that a partially completed filesystem removal cannot be undone.

## Tests (test-first, at the removal seam in `worktree_catalog_rpc.rs` and the supervisor)

- **A Git failure after the quiesce,** through a failing `WorktreeRemovalGit` in the unit-test
  services (the src equivalent of the integration test's `FailingMutationGit`), with a real
  quiescer and supervisor:
  - the error is returned, and the checkout still exists;
  - the idle session's runtime row is `suspended` with its resume cursor;
  - the projection is not active;
  - the next send for the thread relaunches with that cursor.
- **A cancellation after the quiesce:** the same outcome.
- **A cancellation before the quiesce:** refused, with no quiesce (no session suspended or stopped,
  no terminal closed).
- **A successful removal:** the deleted threads' runtime rows are gone. An already-`suspended` row
  of a deleted thread is also deleted.
- **A late suspension after deletion:** the guarded write refuses, and no row is recreated.
- **A current but non-idle session** reaching the removal operation (an active delivery generation,
  or a projected `running`): stopped as today.
- **`removeFromBibCode`:** still detaches, stops running sessions, and cleans runtime rows at
  deletion.

## Live check

On an isolated server with a fake Claude:
1. Create a worktree thread, send one message, and let the session go idle.
2. Make the Git removal fail after the quiesce: remove write permission from the **checkout root**,
   so the root-marker creation fails after the quiesce and before quarantine. A read-only child
   directory is a bad fixture, because it can fail after quarantine.
3. Delete Worktree reports the failure, and the worktree remains.
4. Restore the permission. The thread is usable: the next message resumes the same provider
   session (the fake logs the resumed session id), and nothing shows busy.
5. Take screenshots in light and dark.

## Risks

- **An idle session suspended by a removal that succeeds** has its row deleted at commit. If the
  commit's cleanup fails, a `suspended` row remains: it is inert (startup reconciliation skips
  `suspended`) and it is logged.
- **Terminal processes are still killed on failure.** This is inherent. Their history is kept.

## Second opinion (Codex, read-only) and rulings

1. **The diagnosis is agreed.**
   - `clear_recovered` can fail after the commit. That is on the success side, so nothing is lost.
   - Detach-only removals and prepared post-Git retries bypass the session refusal. Ruling: that is
     why the removal operation falls back to stop for sessions that are not idle.
2. **Suspend confirmed-idle sessions:** adopted, but there is no reusable idleness predicate.
   Ruling: check the projected status and active turn, plus the supervisor's active delivery
   generation. The foreground quiesce and the reaper share the action.
3. **The web does not call `thread.delete` after a removal;** `WorktreeDetachResolved` tombstones
   the threads. Ruling: delete runtime rows in the shared `thread.deleted` transaction, and guard
   the suspension write against deleted threads, because a reaper retry can run after the commit.
4. **Don't move the anchor resolution:** agreed; it stays after the quiesce. Adopted the early
   cancellation check, keeping the late one.
5. **Test seam and live fixture:** adopted: a failing `WorktreeRemovalGit`, and a read-only
   checkout root rather than a read-only child directory.
6. **A pending cleanup and an enqueued stop can run after cancellation.** Ruling: with suspension
   they preserve instead of destroying. Test the late-persistence and suspension-write-failure
   cases. "Nothing lost" is narrowed: a partially completed filesystem removal cannot be undone.
