# Checkpoints: Guard a Shared Checkout's File Restore, and Rewind Only the Conversation

Status: Approved 2026-11-07 (the maintainer pre-approval; reviewed by Codex and advisor). Issue #279, split from #265
([`2026-11-02-side-chats-design.md`](./2026-11-02-side-chats-design.md), "Review findings
and resolutions", round 2, finding 7). Verified at `e222d340ff` (`main` after v0.15.2).
Line references are to that commit. No product code is written until the maintainer approves this
design (the issue's design gate). Companion: #283
([`2026-11-07-checkpoint-git-isolation-design.md`](./2026-11-07-checkpoint-git-isolation-design.md))
changes the Git environment of the same checkpoint commands and lands first.

**Implementation status (2026-11-07).** Implemented for #279. Where it differs from the
text below:

- Preparation of one checkout's restores is serial (step 2 before the gate), so the
  four-permit bound applies across checkouts.
- A sibling's delivery or compaction counts as writing while it is _admitted_ (registered
  under the same engine mutex as the marks and launches), not merely while its thread
  reservation is held. Confirmed by the coordinator: a delivery waiting at the gate holds
  its reservation but cannot write, and counting it would refuse every restore a waiting
  message meets, which defeats the planning-interval gate.
- A thread that never started a provider session and has no turn is not a sibling (the maintainer,
  Q1: it cannot have written a file). The restore still holds it, so its first message waits.
- The preview needs `orchestration:operate`, not read: its temporary-index `git add` runs
  the repository's clean filters, which can run host commands (Codex review).
- A suspended sibling whose provider instance no longer resolves refuses the restore, since
  it may have named an external server (Codex review).
- The HEAD fallback check runs before any sibling is suspended.
- The event-log window compares instants (`julianday`), not strings.
- Test 5 uses a short configurable wait (`EffectsOptions::checkout_restore_admission_wait`)
  instead of a paused clock, which production Git's child processes would advance.

**Revision 1 (2026-11-07)** records the maintainer's decisions (C, D, and the gate's scope) and
answers the first Codex review. See [Review findings and resolutions](#review-findings-and-resolutions).
It changes these things:

- The gate covers the whole planning interval.
- Siblings are found by physical checkout key, across projects.
- Every sibling session is made quiet before the restore.
- A conversation-only rewind requires a provider rewind that keeps files.
- The sibling-change warning reads Git and the event log, not turn rows.

**Revision 2 (2026-11-07)** records the maintainer's round 3 answers and answers Codex round 2.
It changes these things:

- Siblings on an external OpenCode server refuse the restore.
- The checkout key is the canonical Git top level.
- The dialog lists every file the restore changes.
- The token covers content and is revalidated before the rewind.
- Launches and restores serialize on one mutex.

## Outcome

1. A file restore (a checkpoint revert that restores files) is refused while any other
   thread sharing the checkout is running a turn: a chat panel, a side chat, another
   thread on the project root, or a thread of another project on the same directory. The
   refusal names that thread and offers a conversation-only rewind.
2. If files in the checkout changed outside this thread since the target checkpoint, the
   dialog says so and lists them before anything happens.
3. From the moment the restore is planned until it finishes, no turn of any thread in
   that checkout starts. A message sent meanwhile waits and is delivered after.
4. **Rewind conversation only** drops the thread's newer messages and turns and leaves
   the working tree byte for byte unchanged.

## What the code does today (verified)

| Area               | Behaviour at `e222d340ff`                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-thread fence   | `ThreadTurnFence` (`orchestration/engine.rs:1793-1837`): one async mutex per thread, held by the thread's revert and by each of its turn deliveries. In memory only, sound because "the effects worker never replays a revert requested before a restart" (`:1793-1796`). `reserve_thread_turns` and `thread_turns_reserved` (`:2811-2820`).                                                                                 |
| Delivery           | `prepare_claim_and_deliver` (`production/turn_delivery.rs:1650-1700`) runs bootstrap first (`:1661-1663`), then holds the thread's reservation "until the provider has the turn" (`:1671-1679`), not for the whole turn. The fill loop skips a reserved thread so a waiting task holds no slot (`:1092-1097`); queue promotion does the same (`:1493-1500`).                                                                 |
| Revert preparation | `ParkedThreads::run` (`production/orchestration_effects.rs:945-990`): the waiter takes the thread's reservation (`:975`), a preparation permit (`:978`), runs `plan_revert`, then waits for the checkout's previous revert (`:981-983`). The #129 order fix: `order` (`:917-942`) fixes each revert's place per lexically normalized checkout in `tails` at arrival; `resume` (`:1000-1018`) drops `done` after the restore. |
| Busy check         | `plan_revert` (`:1862-1978`) refuses only when **its own** session holds a turn (`:1874-1885`), or its own checkpoint hold stands (`:1888-1892`). Nothing looks at other threads in the checkout. Turn 0 targets ref 0, falling back to `HEAD` (`:1920-1922`, `:1941-1952`).                                                                                                                                                 |
| Restore            | `finish_revert` (`:2023-2165`) on the worker: `rollback_provider` first (irreversible), then `restore_checkpoint` (`restore`, `clean -fd`, `reset`; `:2437-2498`), deleting newer refs, then `thread.revert.complete`. A `FilesOnly` provider restores files and keeps the conversation (`:2041-2089`).                                                                                                                      |
| Background work    | The supervisor refuses a rewind while the reverting session still runs background work (`provider_runtime.rs:9687-9703`, `has_recent_live_activity` `:1079-1085`). It does not look at other sessions.                                                                                                                                                                                                                       |
| Busy test          | `session_holds_a_turn` (`provider_runtime.rs:12946-12948`): `running`/`starting` or an active turn id.                                                                                                                                                                                                                                                                                                                       |
| Side chats         | The engine refuses `thread.checkpoint.revert` for a side chat (`engine.rs:5290-5302`); side chats capture no checkpoints.                                                                                                                                                                                                                                                                                                    |
| Contract           | `thread.checkpoint.revert` is `{commandId, threadId, turnCount, createdAt}` (`packages/contracts/src/orchestration.ts:1226-1232`); the requested payload is `{threadId, turnCount, createdAt}` (`:1654-1658`).                                                                                                                                                                                                               |
| Web                | `onRevertToTurnCount` (`apps/web/src/components/ChatView.tsx:5150-5195`) checks only its own thread, then shows `buildRevertCheckpointConfirmation` (`ChatView.logic.ts:614-635`) through `localApi.dialogs.confirm`, a native boolean dialog (`localApi.ts:21-25`). Worker refusals arrive later as a `checkpoint.revert.failed` activity (`orchestration_effects.rs:2188-2238`).                                           |
| MCP                | `revert_thread_to_turn` (`mcp/tools/threads.rs:960-1060`) pre-checks its own thread, dispatches, and waits for the outcome.                                                                                                                                                                                                                                                                                                  |
| Rewind support     | Only Codex and OpenCode can rewind a conversation (`docs/architecture/rpc-and-orchestration.md:3700-3706`).                                                                                                                                                                                                                                                                                                                  |
| Turn history       | `projection_turns` keeps `requested_at`, `started_at`, `completed_at` and `checkpoint_files_json` for every turn of every thread (`persistence/migrations.rs:961-977`), side chats included.                                                                                                                                                                                                                                 |

**The race the issue names.** A sibling-busy check in `plan_revert` alone can pass, then a
sibling's delivery claims a turn before `restore` and `clean -fd` run, and the restore
overwrites what that turn writes.

## Domain terms

- **Checkout**: the directory a thread's Git commands run in, the thread's stored
  `worktree_path` or, without one, its project's `workspace_root` (the stored half of
  `resolve_thread_workspace`, `:1153-1175`).
- **Checkout key**: the Git worktree that directory belongs to. The key is
  `git rev-parse --show-toplevel` run in the directory, passed through
  `canonical_worktree_path_key` (`git/worktree.rs:182-207`, the physical key the workspace
  availability registry uses: symlinks resolved, path normalized for the host). A project
  at `/repo` and one at `/repo/subdir` therefore share one key, because project
  preparation does not resolve the Git top level (`orchestration_effects.rs:178-193`,
  `:236-255`). A linked worktree's top level is its own directory, so linked worktrees keep
  distinct keys. A directory outside Git falls back to the directory's own canonical key;
  it has no checkpoints, so nothing restores there.
  - **No cache (Codex round 3).** A cached key would outlive a repository change that
    touches no stored path. Example: `/repo/subdir` holds a nested repository whose `.git`
    is later removed, so Git now resolves `/repo`. The key is therefore resolved fresh
    every time it is needed:
    - by the restore, for its own checkout and for **every candidate sibling**, under the
      gate (step 5) and before any mutation;
    - by each delivery and compaction, when it takes admission;
    - by `order`, for the #129 `tails`.
  - **Resolve failure.** If a candidate sibling's top level cannot be resolved (Git fails,
    the directory is gone), the restore treats that sibling as sharing the checkout and
    refuses: "BiBCode can't tell whether Panel, Codex works in this checkout. Try the
    revert again, or check that chat's folder." It never guesses that a sibling is
    elsewhere.
  - **A delivery that keyed before the change.** A sibling delivery in flight may hold
    admission under the old key. Step 5 therefore also counts any sibling whose thread
    reservation is held (`thread_turns_reserved`, `engine.rs:2817-2820`) as writing
    ("is starting a turn"). The restore never relies on the old key alone.
  - The gate, the sibling query and the #129 order (`tails`) all use this one key.
- **Siblings**: every other non-deleted thread, **in any project**, whose checkout has the
  same key: the host's panels and side chats, plain threads without a worktree on the
  project root, a thread of a second project on the same directory, and a thread of a
  project registered on a subdirectory of the same worktree.
- **File restore**: any revert that runs `restore_checkpoint`, including a `FilesOnly`
  provider's.
- **Writing sibling**: a sibling whose session holds a turn (`session_holds_a_turn`), whose
  live session runs recent background work (`has_recent_live_activity`), or whose last
  turn still has a checkpoint hold (its capture would record restored files as its own end
  state).
- **Quiet sibling**: a sibling with no live provider session. A live session can start a
  turn of its own without any delivery (a Codex goal continuation, Claude answering a
  finished background task, OpenCode delivering a subagent's result;
  `provider_runtime.rs:12098-12105`, `provider/opencode/runtime.rs:2871-2877`). Only a
  suspended or stopped session whose provider process BiBCode owns cannot.
- **Unmanaged sibling**: a sibling whose provider instance names an external OpenCode
  server (`serverUrl`, carried into the launch as `endpoint`, `provider_runtime.rs:6221-6222`).
  BiBCode does not own that server: `OpenCodeDriver::shutdown`
  (`provider_runtime.rs:15626-15643`) kills only an owned child, and the runtime's `stop`
  (`provider/opencode/runtime.rs:2134-2164`) only ends BiBCode's observation. The server
  can keep running and self-start the session's work (`:2872-2876`) whether BiBCode's
  session is live or suspended. BiBCode has no verified way to prove that server quiet, so
  an unmanaged sibling is never quiet.

## Alternatives

| Option                                                                                                                                             | For                                                                                                                      | Against                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (A) Sibling-busy check in `plan_revert` only                                                                                                       | Small.                                                                                                                   | The race above.                                                                                                                                                               |
| (B) The revert also takes every sibling's `ThreadTurnFence`, in thread-id order                                                                    | Reuses one fence.                                                                                                        | The sibling set is read before locking, so a panel created meanwhile is not covered. Locking N mutexes needs a global order against deliveries and compactions that take one. |
| (C) Wait for running sibling turns to finish                                                                                                       | No refusal.                                                                                                              | A turn can run for an hour. Holding admission that long stalls every chat in the checkout, and the issue asks for a refusal.                                                  |
| **(D) chosen:** a per-checkout read/write gate held from planning to completion; siblings made quiet under it; writing siblings refuse the restore | Covers threads created later, because the key is the path. No lock order between threads. Closes provider-started turns. | One more gate, one path key per delivery, and an idle sibling session is suspended early.                                                                                     |

## Decisions recorded

- **The maintainer, decision C:** **Rewind conversation only** is a secondary action in every revert
  dialog, and every file-restore refusal points to it.
- **The maintainer, decision D:** turn 0's `HEAD` fallback is refused on a shared checkout.
- **The maintainer, on Codex #279 finding 5:** the gate covers the whole planning interval. Other
  chats in the checkout may wait a few seconds while the reverting chat's provider cold
  starts.
- **The maintainer, round 3:**
  - (a) Git manager actions keep today's no-prompt behaviour; interactive sign-in is a
    follow-up (recorded in #283).
  - (b) The sibling-change warning stays warn and confirm.
  - (c) The lock wait is capped at 15 s.
  - (d) Idle sibling sessions are suspended for the restore.

## Decision: option (D)

### Data shapes and state owner

`OrchestrationEngine` owns a `CheckoutTurnFence`, beside `ThreadTurnFence` and like it in
memory only: `StdMutex<HashMap<String, Weak<tokio::sync::RwLock<()>>>>`, keyed by the
checkout key.

```rust
pub(crate) struct CheckoutTurnAdmission { _guard: OwnedRwLockReadGuard<()> }   // a delivery or compaction
pub(crate) struct CheckoutRestore {                                             // a file restore
    _guard: OwnedRwLockWriteGuard<()>,
    held_threads: Vec<String>, // siblings marked for delivery's skip; cleared and woken on drop
}
```

`CheckoutRestore` also marks its siblings in an engine set, `restore_holds`, so the fill
loop and queue promotion skip them without resolving their checkout (same role as
`thread_turns_reserved` at `turn_delivery.rs:1095` and `:1495`). Dropping it clears the
marks and calls `wake_turn_delivery`. The gate itself is the exclusion; the marks only
keep a waiting task from holding a slot.

Tokio's `RwLock` is fair: once a writer queues, later readers queue behind it, so a stream
of sibling deliveries cannot starve a restore.

### Lock order (the design gate's deadlock question)

Every holder takes the thread gate first and the checkout gate second. Nothing holds a
checkout gate while waiting for a thread gate.

**Delivery** (`prepare_claim_and_deliver`) runs bootstrap first, because the worktree may
not exist before it. Bootstrap dispatches the new worktree path as thread metadata and
awaits it (`turn_delivery.rs:1734-1750`), so the path is stored by then. Delivery then
takes the thread reservation (`:1673`), then checkout admission (shared), then claims and
delivers. Both guards drop when the provider has the turn, as today.

**Compaction** (`orchestration_effects.rs:733-737`) also takes checkout admission (shared)
after its thread gate. A compaction can reopen a suspended session, and a reopened session
could start a turn of its own during a restore.

**File restore** (`ParkedThreads::run`, reordered):

1. Thread reservation (`:975`, unchanged, taken first so a later message cannot overtake).
2. `previous.await`: the checkout's previous revert has restored (the #129 order).
3. Checkout gate, exclusive. The wait is bounded by `CHECKOUT_RESTORE_ADMISSION_WAIT`
   (15 s). On timeout the request to lock is dropped, deliveries queued behind it proceed,
   and the revert is refused: "Another chat in this checkout is starting a turn. Try the
   revert again in a moment." Nothing has changed at that point.
4. Preparation permit.
5. `plan_revert`, under the gate: today's own-thread checks and target resolution, then
   the shared-checkout checks (below), then `prepare_provider_rewind` (possibly a cold
   start).
6. Hand back to the worker with the plan, the reservation and the `CheckoutRestore`.
7. Worker, `finish_revert`: re-check the siblings, then `rollback_provider`,
   `restore_checkpoint`, refs, outcome.
8. `revert` (`:764-780`) drops the reservation and the `CheckoutRestore`, then `resume`
   drops `done` (`:1009-1010`) so the checkout's next revert may proceed.

The gate is therefore held from the moment the restore is planned (step 5 begins under
it) until the restore is recorded. A sibling turn sent at any point in steps 3 to 8 waits;
one already running when step 5 checks makes the restore refuse.

**How long siblings may wait.** Steps 4 to 8 hold the gate. The permit wait (step 4) is
bounded by the four preparations of other checkouts. The cold start in step 5 is bounded
by the provider's own launch and reopen failure paths, which fail the revert today. The
provider rewind and Git restore are today's work. A delivery waiting behind the gate shows
its message as pending, as a message behind a revert of its own thread does today.

Why there is no deadlock:

- **Previous revert before the gate.** If revert R2 took the exclusive gate before
  awaiting R1's `done`, R1 could never take it. Step 2 precedes step 3, and R1 drops the
  gate (step 8) before its `done`.
- **No thread gate under a checkout gate.** A delivery waiting for checkout admission
  holds its own thread gate. The restore holding the checkout gate never wants that
  thread's gate, only its own, taken at step 1.
- **Permits under a gate.** A preparation permit is held only by step 5 of a revert that
  already holds its own checkout's gate. No permit holder waits for another checkout's
  gate, so there is no cycle.
- **Long turns are never waited for.** A running sibling turn holds no gate (a delivery's
  hold ends when the provider has the turn). The restore sees it as a writing sibling and
  refuses.
- **Deliveries in flight are bounded by the wait** in step 3.
- **A refused restore still releases everything.** Refusals return `Err` in the plan,
  which goes through the same `revert` and `resume` path, so `done` drops and the next
  revert runs.

Capture and restore still run on the effects worker one at a time. The gate coordinates
turn admission only; it does not serialize Git.

### Shared-checkout checks (step 5, repeated in step 7)

1. List siblings by key. With none, the restore is unguarded, as today.
2. Refuse when any sibling is writing.
3. **Make every sibling quiet** (Codex #279 finding 2). For a sibling with a live, idle
   session, the supervisor suspends it now through the idle-suspension path
   (`suspend_idle_session`, `provider_runtime.rs:13015-13030`), which shuts the driver
   down and persists `suspended`. Its next message reopens it through delivery, which the
   gate holds. The restore refuses when a sibling's live session cannot be suspended
   safely: it runs background work, or BiBCode cannot see its work at all
   (`session_reports_its_work` false: Cursor, Grok, or Chat Activity off;
   `provider_runtime.rs:12964-12967`). The refusal names it: "BiBCode can't tell whether
   Panel, Grok is still working. Stop its session, then revert." An unmanaged sibling
   (external OpenCode server) always refuses the restore, live or suspended: "Panel,
   OpenCode runs on an OpenCode server BiBCode doesn't manage, so BiBCode can't make sure
   it has stopped working in this checkout. Rewind only the conversation instead."
4. Compute sibling changes and compare the caller's token (below).
5. Refuse turn 0's `HEAD` fallback (below).

New callbacks on `OrchestrationEffectCallbacks`, answered by the supervisor:
`thread_writes_checkout(thread_id) -> Option<WritingReason>` and
`quiet_sibling(thread_id) -> Result<(), WritingReason>`.

**No launch while the restore holds the checkout.** A suspended sibling must stay
suspended until the restore ends, whatever would start it again.

- **One choke point.** Every production provider driver is created at one line,
  `factory.create(request)` inside `launch_session` (`provider_runtime.rs:9166`; the other
  `factory.create` calls, from `:29262` on, are in `#[cfg(test)]` modules).
  `launch_session` (`:9095`) has three callers: `direct_session_with_terminal_events`
  (`:5320`), the supervisor loop `run_supervisor` (`:6640`), and `restart_session`
  (`:10777`).
- **What reaches it.** Delivery's launch, `reopen_for_rewind` (`:9780`, both revert modes
  through `prepare_provider_rewind`), `reopen_for_compaction` (`:10008`) and
  `launch_for_reconciliation` (`:1306`) all go through the supervisor's
  `launch_with_context_handoff`. MCP tools, UI intents and automations start turns as
  orchestration commands, so they reach a launch only through delivery. Side chats are
  threads and take the same path. A provider's self-started turn runs inside an already
  live session, which step 3 suspends, or on an unmanaged server, which refuses.
- **Explicit serialization.** Revision 1 said a launch in progress shows its session as
  `starting`. That is wrong. `launch_session` persists the runtime as `connecting` before
  `driver.start()` and projects `ready` only afterwards (`:9166-9179`, `:9318`); nothing
  marks the thread session busy in between. The engine therefore keeps one mutex over two
  sets, `restore_holds` and `launching` (thread id to count):
  - `launch_session` takes the mutex first. A thread in `restore_holds` is refused with
    "Another chat in this checkout is restoring files. Try again in a moment." Otherwise
    the thread's count in `launching` goes up. A guard lowers it when the launch ends,
    with success or failure.
  - Step 5 takes the same mutex to mark the siblings. A sibling in `launching` refuses the
    restore ("Another chat in this checkout is starting its session. Try the revert again
    in a moment."); otherwise the siblings are inserted into `restore_holds` while the
    mutex is still held.
  - So a launch either finishes registering before the restore marks, and the restore
    refuses, or it starts after, and the launch is refused. No interleaving lets both
    proceed.
- The restoring thread is never in its own `restore_holds`, so its own
  `prepare_provider_rewind` launches normally. A sibling's conversation-only rewind during
  the restore fails at its reopen and changes nothing.

Step 7 repeats checks 2 and 3 on the worker immediately before the irreversible rewind.
Every sibling is then suspended and cannot be reopened, so no sibling turn can start
between the check and the end of the restore.

**Workspace admission under the gate.** `prepare_provider_rewind` takes
`WorkspaceAdmissionController::acquire_thread` (`runtime.rs:1131-1136`), which deliveries
also use. That call does not wait for other holders: `acquire_admission_inner`
(`worktree_catalog/availability.rs:475-523`) awaits only the path canonicalization and
returns `Unavailable` when the workspace is being removed. Holding the checkout gate while
calling it therefore adds no wait cycle.

### Conversation-only rewind

A mode on the existing command, not a new command, so the engine path, outcome events and
MCP wait loop are shared:

- `ThreadCheckpointRevertCommand` and `ThreadCheckpointRevertRequestedPayload` gain
  `mode: "full" | "conversationOnly"`, optional, default `"full"`, and
  `siblingChangesToken: string`, optional. The Rust enum gains the same fields with
  `#[serde(default)]`. Replaying an older event yields `full`, so a projection rebuild is
  unchanged. No migration.
- **It needs a rewind that leaves files alone** (Codex #279 finding 1). The provider
  layer gains `rewind_keeps_files(provider, api_version) -> bool`:

  | Provider and API     | Rewind call                                                | Keeps files    | Evidence                                                                                                                                  |
  | -------------------- | ---------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
  | Codex                | `thread/revert` with `beforeTurnId`                        | yes            | `provider/codex/runtime.rs:1530-1532` ("Codex does not touch files")                                                                      |
  | OpenCode 2           | `revert/stage` with `"files": false`, then `revert/commit` | yes            | `provider/opencode/runtime.rs:4191`; test `rollback_reverts_from_the_start_of_the_nth_most_recent_turn` (`v2_runtime_tests.rs:1870-1892`) |
  | OpenCode 1           | `POST /session/{id}/revert` with only `messageID`          | **no**         | `provider/opencode/runtime.rs:2106-2113`; OpenCode 1 reverts its file snapshots in that call                                              |
  | Claude, Cursor, Grok | none (`FilesOnly`)                                         | not applicable | `rpc-and-orchestration.md:3700-3706`                                                                                                      |

  A conversation-only rewind on a provider without it is refused before any provider call:
  "OpenCode 1 can't rewind its conversation without restoring files. Revert files and
  conversation instead." For `FilesOnly` providers: "Claude can't rewind its conversation,
  so only a file restore is possible." The supervisor answers from the live session's
  launch, after `prepare_provider_rewind` reopened it, so the API version is known.

- It takes the thread reservation only: no checkout gate, no `tails` place (`order` skips
  it), because it writes no file. It runs today's own-thread checks, then
  `rollback_provider`, deletes the newer checkpoint refs and dispatches
  `thread.revert.complete`, as a full revert does, plus an info activity
  `checkpoint.revert.conversation-only`, "Conversation rewound, files kept". It never runs
  `restore`, `clean` or `reset`.
- Side chats stay refused by the engine (`engine.rs:5290-5302`) in both modes.
- The next turn's diff runs from the target's ref, so it also shows the files the rewind
  kept. Diffs in a shared checkout already include whatever changed between two turns, so
  this is consistent; the activity says the files were kept.

### What the restore changes, and the sibling-change warning

The evidence must survive what siblings do to their own threads (Codex #279 finding 3).
`thread.reverted` deletes a thread's newer `projection_turns` rows (`engine.rs:8310-8318`),
so a sibling's conversation-only rewind would erase the turns whose files it kept, and a
deleted sibling's rows go with it. The dialog therefore reads three things that no sibling
action removes. All Git reads use one temporary index, as capture does, in the #283
checkpoint environment.

1. **Every file the restore will change.** `read-tree <newest ready checkpoint ref>`, then
   `add -A`, then `write-tree` gives the **current tree**, the content of every tracked and
   untracked, non-ignored file now. `diff --name-only <target ref> <current tree>` lists
   every path the restore will rewrite or delete. This list is always shown. It is the
   conservative evidence for changes whose author BiBCode cannot know: an editor change
   absorbed into this thread's own later checkpoint is in it, unattributed (Codex #279
   round 2 finding 3).
2. **Changes since this thread's last turn.** `diff --name-only <newest ready checkpoint
   ref> <current tree>`. The thread is idle (a busy thread is refused), so each path was
   changed by someone else: a sibling, a terminal or an editor.
3. **Sibling turns between the target and this thread's last turn**, from the event log.
   `orchestration_events` is append-only; nothing deletes from it (`rg "DELETE FROM
   orchestration_events"` finds nothing). The query reads, for every thread whose stored
   checkout has the key, deleted threads included, the `thread.turn-diff-completed` events
   (with their file lists) and the `thread.session-set` events that start a turn, with
   `occurred_at` after the target's time and up to this thread's newest checkpoint. A turn
   without a file list (a side chat) shows "files not known".

The target's time is the target checkpoint row's `completed_at`; for turn 0 it is turn 1's
`started_at`, or `requested_at` when that is null. The reverting thread's own rows are
intact, because only this revert would delete them.

**What the warning promises.** It names changes known to come from outside this thread:
items 2 and 3. A change made outside BiBCode between two of this thread's turns, and
captured into its later checkpoint, cannot be told apart from the thread's own work. It
appears only in item 1's list of files the restore changes. The dialog says so plainly
("Files this revert restores") instead of claiming all outside changes are flagged.

**Token with content identity** (Codex #279 round 2 finding 4).
`siblingChangesToken` is the hex SHA-256 of:

- the target ref's commit id;
- the current tree id from item 1, which changes when any file's bytes change, even with
  the same path list;
- the sorted event ids from item 3.

It is always present for a shared checkout. The restore proceeds only when the command's
token equals the one recomputed under the gate.

**Revalidated before mutation.** Step 7 on the worker recomputes the current tree id
immediately before `rollback_provider`, with the siblings quiet and the gate held, and
refuses when it differs from the token. Detail: "Files in this checkout changed after you
confirmed. Review them and revert again." This adds one capture-sized Git read to the
restore. What remains is a terminal or editor writing in the moments between that read
and `git restore`, outside anything BiBCode can hold.

### Turn 0 on a shared checkout (the maintainer, decision D)

When ref 0 is missing, turn 0 falls back to `HEAD` (`:1920-1922`). With `clean -fd` that
discards every uncommitted change in the checkout, including idle siblings' work. With at
least one sibling, the fallback is refused: "This thread has no starting checkpoint, and
other chats share this checkout, so restoring files would discard their work. Rewind only
the conversation, or revert to a later turn." A thread alone in its checkout keeps
today's fallback.

### Pre-dispatch read: `orchestration.previewCheckpointRevert`

Worker refusals land after dispatch as activities, and the native confirm dialog has only
two unnamed buttons. "Warn first" and "offer a conversation-only rewind" therefore need a
read before the dialog:

```ts
// packages/contracts/src/orchestration.ts
previewCheckpointRevert: "orchestration.previewCheckpointRevert"
input:  { threadId, turnCount }
output: {
  writingSiblings: Array<{ threadId, title, reason: "turn" | "backgroundWork" | "checkpointPending" | "unobservable" | "unmanagedServer" | "startingSession" }>,
  restoredPaths: string[],                 // item 1: every file the restore changes
  siblingChanges: { paths: string[], turns: Array<{ threadId, title, turns: number, files: string[] | null }> },
  siblingChangesToken: string | null,      // null only when no other thread shares the checkout
  conversationRewind: "available" | "filesOnlyProvider" | "rewindRestoresFiles",
  headFallbackRefused: boolean,
}
```

It runs Git (items 1 and 2), so it joins `is_long_running` in
`diagnostics/profiler/latency.rs` like the other Git-backed reads. It is advisory: the
worker repeats every check under the gate. Its conversation-rewind answer comes from the
session's last launch and is confirmed by the worker.

### UI copy (checked against `UI.md` and Impeccable's clarify guidance)

The native confirm is replaced by the app's alert dialog (`AlertDialog`, already used in
`ProjectScriptsControl.tsx` and `settings/WebhooksTab.tsx`) with named buttons. No em
dashes in our copy; thread titles are shown as they are.

Normal revert, provider can rewind:

> **Revert to checkpoint 3?**
> Files go back to how they were after turn 3, and newer messages in this thread are
> removed. This can't be undone.
> [**Revert files and conversation**] (destructive, primary) [Rewind conversation only] [Cancel]

On a shared checkout the dialog always lists the files the revert restores (at most five,
then "and N more", expandable):

> Files this revert restores: `src/app.ts`, `README.md`, `package.json`

With changes known to come from outside this chat (at most three files per line, then
"and N more"):

> Other chats in this checkout changed files since then. Reverting files undoes these too:
> Panel, Codex: 2 turns, `src/app.ts`, `README.md`
> Side chat: 1 turn, files not known
> Changed since this chat's last turn: `package.json`

A sibling is writing:

> **Can't restore files right now**
> Panel, Codex is running a turn in this checkout. Stop it or wait for it to finish, then
> revert. You can rewind only this conversation now; files stay as they are.
> [**Rewind conversation only**] [Cancel]

The reason line varies: "is running background work", "is still saving its checkpoint",
"BiBCode can't tell whether Panel, Grok is still working. Stop its session, then revert."
When conversation-only is unavailable, the second sentence and that button are left out,
and the only button is [Close].

Provider cannot rewind (today's text, now with named buttons):

> **Restore files to checkpoint 3?**
> Claude can't rewind its conversation, so the newer messages stay. This can't be undone.
> [**Restore files**] [Cancel]

OpenCode 1: the normal dialog without [Rewind conversation only].

The **Revert to this message** control stays enabled while a sibling is busy: the dialog
explains why the file restore is unavailable and offers the alternative, instead of a
disabled button that cannot.

Worker refusals (`checkpoint.revert.failed` detail, and MCP `McpCheckpointRevertError`):

| Case                           | Detail                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Writing sibling                | "Another chat in this checkout (Panel, Codex) is running a turn. Stop it or wait for it to finish, then revert, or rewind only the conversation."                              |
| Sibling work not observable    | "BiBCode can't tell whether Panel, Grok is still working. Stop its session, then revert, or rewind only the conversation."                                                     |
| Gate wait expired              | "Another chat in this checkout is starting a turn. Try the revert again in a moment."                                                                                          |
| Unacknowledged changes         | "Files in this checkout changed since turn 3, outside this chat. Review them and revert again." (carries the token)                                                            |
| Changed after confirming       | "Files in this checkout changed after you confirmed. Review them and revert again." (carries the new token)                                                                    |
| Unmanaged sibling              | "Panel, OpenCode runs on an OpenCode server BiBCode doesn't manage, so BiBCode can't make sure it has stopped working in this checkout. Rewind only the conversation instead." |
| Sibling session starting       | "Another chat in this checkout is starting its session. Try the revert again in a moment."                                                                                     |
| `HEAD` fallback refused        | as above                                                                                                                                                                       |
| Conversation-only, `FilesOnly` | "Claude can't rewind its conversation, so only a file restore is possible."                                                                                                    |
| Conversation-only, OpenCode 1  | "OpenCode 1 can't rewind its conversation without restoring files. Revert files and conversation instead."                                                                     |

### MCP

`revert_thread_to_turn` gains `mode` (`"full"` default, `"conversationOnly"`) and
`siblingChangesToken`. Its pre-check calls the same preview. An unacknowledged change
returns `McpSharedCheckoutChangedError` with the paths, sibling turns and the token in
structured content; the agent repeats the call with the token. A writing sibling returns
`McpTurnRunningError` naming the sibling.

## Failure, restart and concurrency

- **Restart.** Both gates and `restore_holds` are in memory. That is sound for the reason
  `ThreadTurnFence` gives (`engine.rs:1793-1796`): the worker never replays a revert
  requested before a restart. A restore interrupted by a crash leaves the checkout part
  restored, as today; the person reverts again. A sibling suspended by step 5 stays
  suspended and reopens on its next message, as after idle suspension.
- **Shutdown.** The waiter's `select!` on cancellation (`:971-987`) drops the guards. Once
  the provider has rewound, the restore is uninterruptible (`:2093-2098`) and holds the
  gate until it is recorded.
- **What the guard does not cover.** The person's terminals, editors and agents outside
  BiBCode. Their changes since this thread's last turn do appear in the warning (Git
  source).
- **Mixed versions.** An older client sends no `mode` (full) and no token. It still works
  unless files changed outside the thread since the target, when the worker refuses with
  the detail above; the work log shows it. An older server ignores the new fields, so a
  newer client offers **Rewind conversation only** only when the server advertises
  `conversationOnlyRewind: true` in its environment capabilities (`http.rs:752-761`,
  `:781-788`; contract `ExecutionEnvironmentCapabilities`, `environment.ts:30`, default
  `false`).
- **Performance.** One `git rev-parse --show-toplevel` plus one `canonicalize` per
  delivery and per compaction, and one uncontended `RwLock` acquisition. Each revert
  dialog and each guarded restore run one sibling query across projects, **one
  `rev-parse` per candidate sibling**, and the capture-sized Git reads. Candidates are the
  non-deleted threads whose canonical stored directory lies inside the restoring
  checkout's freshly resolved top level: a directory outside it cannot resolve to it. So
  unrelated projects cost one `canonicalize` each and no Git call.

## Tests, mapped to the acceptance

Acceptance 1, "pauses revert preparation, attempts a sibling turn, and shows the turn is
held or refused until the restore completes":

1. `a_sibling_turn_waits_while_restore_planning_holds_the_checkout`: a test hook pauses
   `plan_revert` at its start (step 5, under the gate). Send a panel message on the same
   worktree; assert the panel's delivery is not claimed; release; assert the restore
   finished before the panel's claim.
2. `a_sibling_turn_waits_during_the_cold_start`: the same, paused in
   `prepare_provider_rewind` (`turn_delivery_queue_tests.rs:930-938` hook).
3. `a_sibling_turn_waits_until_the_restore_itself_completes`: paused in the host's
   `rollback_provider` (`:911-928` hooks).
4. `a_sibling_delivery_in_flight_makes_the_restore_wait_then_refuse`: hold a panel
   delivery before its provider accepts; request the host restore; release; the restore is
   refused naming the panel, and the files are unchanged.
5. `a_restore_gives_up_after_the_admission_wait`: a delivery that never accepts; the
   restore is refused after 15 s (paused clock), and the panel's next delivery is not
   blocked.
6. `reverts_of_one_checkout_still_restore_in_request_order_under_the_gate` (the #129 test,
   extended with a panel delivery in between).
7. `a_symlinked_or_second_project_path_is_the_same_checkout`: a second project registered
   on a symlink to the first's root shares one gate; two Git worktrees of one repository
   do not. The differently cased spelling case runs only when a probe (create `a`, stat
   `A`) shows the test directory's file system is case-insensitive, and prints why it
   skipped otherwise.
   7b. `a_project_on_a_subdirectory_shares_the_worktree_gate` (Codex #279 round 2 finding 2):
   project P1 at `/repo`, project P2 at `/repo/subdir` of the same worktree. P2's thread is
   a sibling of P1's restore and is held by its gate; a linked worktree of `/repo` is not.
   7c. `removing_a_nested_git_dir_makes_the_subdir_a_sibling_without_metadata_change`
   (Codex round 3): `/repo/subdir` starts as a nested repository with its own `.git`; a
   P2 thread there runs turns and is not a sibling of a `/repo` restore. Remove
   `/repo/subdir/.git` only, with no project or thread metadata change. A `/repo` restore
   now finds the P2 thread as a sibling, refuses while it is busy, and is held by the same
   gate for its next delivery.
   7d. `an_unresolvable_sibling_refuses_the_restore`: a candidate sibling whose folder is
   gone, or whose `rev-parse` fails (fake `git`), makes the restore refuse with the
   "can't tell whether" detail.
   7e. `a_delivery_keyed_before_the_change_still_makes_the_restore_refuse`: a sibling
   delivery holds its thread reservation under the old key; the restore counts it as
   writing.

Acceptance 2, "a host restore while a panel is busy is refused, with an actionable
message":

8. `a_restore_is_refused_while_a_panel_runs_a_turn`: detail names the panel and the
   conversation-only alternative; files and conversation unchanged; provider not rewound.
9. `a_restore_is_refused_while_a_sibling_runs_background_work`.
10. `a_restore_is_refused_while_a_sibling_checkpoint_is_pending`.
11. `a_restore_is_refused_when_a_sibling_session_is_unobservable` (a Cursor-like fake with
    `session_reports_its_work` false).
12. `an_idle_sibling_session_is_suspended_before_the_restore`, and
    `a_provider_started_sibling_turn_cannot_begin_after_the_last_check`: a fake sibling
    driver that emits `turn.started` with `providerStarted: true` when released. Release
    it after step 7's check, during `rollback_provider`. The driver is already shut down,
    so no turn starts and the restore completes; then the panel's next message reopens
    it. Plus `no_path_reopens_a_sibling_during_the_restore`: with the restore paused under
    the gate, a sibling's delivery, compaction, conversation-only rewind and delivery
    reconciliation each fail at `launch_session` (the rewind with the "restoring files"
    detail).
    12b. `a_launch_in_flight_makes_the_restore_refuse` (Codex #279 round 2 gap b): a fake
    factory pauses a sibling's `launch_session` after it registered in `launching` and
    before `driver.start()`; the restore refuses with "starting its session". The reverse
    order (restore marks first, then the launch) refuses the launch.
    12c. `an_unmanaged_opencode_sibling_refuses_the_restore` (Codex #279 round 2 finding 1): a
    sibling on an OpenCode instance with `serverUrl` refuses the restore both with its
    BiBCode session live and after it is suspended; a sibling on a BiBCode-started
    OpenCode server is suspended and does not refuse.
13. `turn_zero_head_fallback_is_refused_on_a_shared_checkout` and
    `turn_zero_head_fallback_still_works_alone`.

Acceptance 3, "a conversation-only rewind leaves the working tree byte for byte
unchanged":

14. `a_conversation_only_rewind_leaves_the_working_tree_unchanged`: before and after,
    compare every path under the checkout except `.git` (tracked, modified, untracked and
    ignored files, and an empty directory) by bytes, plus `git status --porcelain=v2
    --ignored`. Assert the provider rewound, newer messages and turns are gone, newer refs
    deleted, target ref kept.
15. `a_conversation_only_rewind_runs_while_a_sibling_is_busy`.
16. `a_conversation_only_rewind_is_refused_for_a_files_only_provider` and
    `…_for_opencode_1`: nothing changes, and the OpenCode 1 replay server records no
    `/revert` request.
17. Provider behaviour, against the existing replay fixtures: OpenCode 2's rewind sends
    `"files": false` (`v2_runtime_tests.rs:1870-1892`, kept), and Codex's rewind sends
    only `thread/revert`. A live check against real OpenCode 1 and 2 and Codex, rewinding a
    turn that edited a file and asserting the file is unchanged, goes in the execution
    report: the replay fixtures prove what BiBCode sends, not what the provider does.

Warning:

18. `sibling_changes_need_the_matching_token`: no token refuses with the token; the token
    restores; a sibling turn finishing after the preview changes the token and refuses.
19. `a_sibling_conversation_only_rewind_keeps_its_changes_in_the_warning` (Codex #279
    finding 3): A finishes turn 1; panel B edits `x` in a turn; B rewinds conversation
    only; A's restore to turn 1 without a token is refused and lists `x`. The same with B
    deleted instead.
20. `a_terminal_edit_since_the_last_turn_is_listed`.
    20b. `an_edit_absorbed_into_a_later_checkpoint_is_listed_as_restored` (Codex #279 round 2
    finding 3): A's turn 1; an editor changes `x`; A's turn 2 captures `x`; the preview of a
    restore to turn 1 lists `x` under "Files this revert restores" and not as an outside
    change.
    20c. `a_content_change_with_the_same_paths_changes_the_token` and
    `a_change_after_confirming_is_caught_before_the_rewind` (Codex #279 round 2 finding 4):
    the same path list with different bytes gives a different token; a file written after
    the plan and before step 7 makes the restore refuse with the provider not rewound.
21. Preview RPC: `preview_reports_writing_siblings_changes_and_rewind_support`.

Contracts and web:

22. Contracts: `mode` defaults to `full`; an event without it decodes.
23. `ChatView.logic` tests: dialog model for each case (normal, sibling changes, writing
    sibling with and without conversation-only, files-only provider, OpenCode 1).
24. MCP: `revert_thread_to_turn` with `conversationOnly`, and the token round trip.

## Files to change

- `apps/server/src/orchestration/engine.rs`: `CheckoutTurnFence`, the fresh checkout-key resolver (no cache),
  one mutex over `restore_holds` and `launching`, the command and requested-payload fields.
- `apps/server/src/production/orchestration_effects.rs`: `ParkedThreads::order` (physical
  key) and `run` (reordered, gate), `plan_revert` (shared-checkout checks), `finish_revert`
  (re-check, conversation-only branch), compaction's admission, the new callbacks, and a
  `pub(crate) async fn checkout_changes_since(cwd, reference, cancellation)` that runs the
  Git read through the private `run_git` (`:2569`), so the preview RPC reaches it without
  exposing `run_git`.
- `apps/server/src/production/turn_delivery.rs`: shared admission in
  `prepare_claim_and_deliver`; `restore_holds` skips at `:1095` and `:1495`.
- `apps/server/src/production/provider_runtime.rs`: `thread_writes_checkout`,
  `quiet_sibling` (including the unmanaged-server refusal from the thread's provider
  instance `serverUrl`), and the `restore_holds`/`launching` check at the start of
  `launch_session` (`:9095`);
  `apps/server/src/provider/mod.rs`: `rewind_keeps_files`.
- `apps/server/src/persistence/repositories.rs`: the cross-project sibling query and the
  event-log query.
- `apps/server/src/production/orchestration_rpc.rs` and `rpc/session.rs`: the preview
  method; `diagnostics/profiler/latency.rs`: `is_long_running`.
- `apps/server/src/mcp/tools/threads.rs`: `mode`, token, errors.
- `apps/server/src/http.rs`: `conversationOnlyRewind` capability.
- `packages/contracts/src/orchestration.ts`, `environment.ts`; `packages/client-runtime`
  thread commands and the preview query.
- `apps/web/src/components/ChatView.tsx`, `ChatView.logic.ts`: the dialog.
- Living docs: `docs/architecture/rpc-and-orchestration.md` "Checkpoint revert" and the
  MCP section (`:3834-3839`), `docs/user/workspace-ui.md` (revert dialog), the MCP tool
  description, `docs/skills/bibcode-profiler/references/` if `is_long_running` is listed
  there. `docs/architecture/overview.md` is coordinator-reserved: one line under
  checkpoints, "A file restore holds its checkout's turn admission from planning to
  completion and refuses while another chat there is writing."

## Profiler, crash and trace coverage

- **RPC methods.** `orchestration.previewCheckpointRevert` is registered through the
  `rpc/session.rs` wrappers, so it is timed, and added to `is_long_running` because it
  runs a capture-sized Git read.
- **Logs.** A refused restore already becomes `checkpoint.revert.failed` through
  `append_failure_activity` and `tracing::warn!` (`:782-791`). A gate wait that expires
  and a sibling suspension each log one `tracing::warn!` or `tracing::info!` with thread
  ids and no path.
- **Child processes.** None new: the Git read runs through `ProcessRunner`, and suspension
  uses the supervisor's existing shutdown path.
- **Not applicable.** Worktree removal, binaries, shutdown order, profiler events.

## Risks

- **Suspending an idle sibling early** costs its next message a cold start. Idle sessions
  suspend after 60 s anyway (`DEFAULT_SESSION_IDLE_TIMEOUT`, `provider_runtime.rs:136`).
- **Unobservable providers** (Cursor, Grok, or Chat Activity off) refuse every shared
  restore while their session is live, until idle suspension or a stop.
- **The 15 s admission wait** is a judgement; the test uses a paused clock.
- **The Git read** in preview, under the gate and again in step 7 costs as much as a
  capture on a large checkout each time, and the last two hold the gate.
- **External OpenCode servers** block every file restore on a shared checkout. A
  verified way to prove such a server quiet (for example a session status read) would lift
  this; it is a follow-up, not designed here.
- **Terminals and editors** can still write between step 7's revalidation and
  `git restore`. Nothing BiBCode runs can hold them.
- **Provider rewind behaviour** is known from BiBCode's source and replay fixtures; the
  live check in test 17 confirms it.
- Replacing the native confirm changes a desktop dialog into an in-app one. The in-app
  dialog must keep keyboard focus and Escape behaviour (`AlertDialog` does).

## Questions only the maintainer can answer

None open. The maintainer answered round 3's questions (see "Decisions recorded").

## Review findings and resolutions

Codex review, round 1, of revision 0. The coordinator verified findings 1, 2 and 4 in
source; each was checked again here at `e222d340ff`.

| #     | Finding                                                                                | Checked                                                                                                                                                  | Resolution                                                                                                                                                                                                                                                                                                                                         |
| ----- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 #1 | OpenCode 1's rewind restores files, so a conversation-only rewind would not keep them. | Confirmed: OpenCode 1 posts `/session/{id}/revert` with only `messageID` (`opencode/runtime.rs:2106-2113`); OpenCode 2 sends `"files": false` (`:4191`). | **Fixed.** `rewind_keeps_files` per provider and API version; OpenCode 1 refused before any call. Tests 16 and 17, with a live check in the execution report.                                                                                                                                                                                      |
| P1 #2 | Provider-started turns bypass delivery and can begin after the last check.             | Confirmed: `providerStarted` and self-started turns (`provider_runtime.rs:12098-12105`, `opencode/runtime.rs:2871-2877`).                                | **Fixed.** Every sibling is made quiet under the gate: an idle live session is suspended, a session that cannot be suspended safely refuses the restore, and the supervisor refuses to launch or reopen a session for a held sibling by any path (delivery, compaction, rewind, reconciliation). Compaction also takes admission. Tests 11 and 12. |
| P1 #3 | A sibling's conversation-only rewind deletes the turn rows the warning reads.          | Confirmed: `thread.reverted` deletes newer `projection_turns` (`engine.rs:8310-8318`).                                                                   | **Fixed.** The warning reads Git (changes since this thread's last turn) and the append-only event log, which no sibling action deletes. Test 19.                                                                                                                                                                                                  |
| P1 #4 | The lexical, project-scoped key misses symlinks, case and other projects.              | Confirmed: `normalize_host_path_lexically` in `order` (`:926-930`); siblings were read per project.                                                      | **Fixed.** One physical key, `canonical_worktree_path_key`, already used by workspace availability, for the gate, siblings (all projects) and `tails`. Test 7.                                                                                                                                                                                     |
| P2 #5 | Steps 1 to 3 of revision 1 left admission open during preparation.                     | Confirmed against revision 1.                                                                                                                            | **Fixed by the maintainer's decision.** The gate covers the whole planning interval; the #129 order and the lock order are kept. Tests 1 to 3 pause inside planning.                                                                                                                                                                               |

Codex review, round 2, of revision 1. Each finding was checked in source at `e222d340ff`.

| #     | Finding                                                                                                 | Checked                                                                                                                                                                                          | Resolution                                                                                                                                                                                                                                                                                                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 #1 | Shutting down an OpenCode session on an external server does not stop the server, which can self-start. | Confirmed: `OpenCodeDriver::shutdown` kills only an owned child (`provider_runtime.rs:15626-15643`); `stop` ends observation only (`opencode/runtime.rs:2134-2164`); self-start at `:2872-2876`. | **Fixed.** An unmanaged sibling (instance with `serverUrl`) refuses every file restore, live or suspended. Quiescence of an external server is not provable today, so no exception. Test 12c.                                                                                                                                                                                                  |
| P1 #2 | The directory key misses `/repo` and `/repo/subdir` projects on one worktree.                           | Confirmed: project preparation canonicalizes the directory but does not resolve the Git top level (`orchestration_effects.rs:178-193`, `:236-255`).                                              | **Fixed.** The key is the canonicalized `git rev-parse --show-toplevel`, resolved fresh at admission (revision 3 dropped the cache); linked worktrees stay distinct. Test 7b.                                                                                                                                                                                                                  |
| P2 #3 | An editor change absorbed into a later own checkpoint shows no warning.                                 | Confirmed against revision 1: neither source covered it.                                                                                                                                         | **Fixed by both remedies.** The dialog always lists every file the restore changes (conservative, unattributed), and the warning's promise is narrowed to changes known to come from outside the thread. Test 20b.                                                                                                                                                                             |
| P2 #4 | The token hashes paths and event ids only.                                                              | Confirmed against revision 1.                                                                                                                                                                    | **Fixed.** The token hashes the target commit, the current tree id (content) and the event ids; step 7 recomputes the tree id before the rewind. Test 20c.                                                                                                                                                                                                                                     |
| Gap b | Revision 1's claim that a launch in progress shows `starting` is wrong.                                 | Confirmed: `launch_session` persists `connecting` before `driver.start()` and projects `ready` after (`provider_runtime.rs:9166-9179`, `:9318`).                                                 | **Corrected.** Explicit serialization: one engine mutex over `restore_holds` and `launching`, taken by `launch_session` and by step 5. Start paths checked: the single production `factory.create` (`:9166`) and the three `launch_session` callers; MCP tools, UI intents and automations reach it only through delivery; side chats are threads; self-starts run in live sessions. Test 12b. |

Codex check, round 3, of revision 2: one finding.

| #   | Finding                                                                                                                                                                        | Checked                                                                                                                                                                      | Resolution                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | The cached key outlives a repository change that touches no stored path (a nested `.git` removed), so a root restore misses the subdirectory sibling and overwrites its files. | Confirmed against revision 2: the cache was dropped only on stored-path changes, and restore runs `restore` and `clean -fd` over `.` (`orchestration_effects.rs:2449-2480`). | **Fixed (revision 3).** No cache. The restore resolves its own and every candidate sibling's top level fresh under the gate, refuses on a resolve failure, and counts a reserved sibling thread as writing. Tests 7c, 7d and 7e. |
