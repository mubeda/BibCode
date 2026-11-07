# Checkpoints: Guard a Shared Checkout's File Restore, and Rewind Only the Conversation

Status: Proposed, awaiting Codex and advisor review. Issue #279, split from #265
([`2026-11-02-side-chats-design.md`](./2026-11-02-side-chats-design.md), "Review findings
and resolutions", round 2, finding 7). Verified at `e222d340ff` (`main` after v0.15.2).
Line references are to that commit. No product code is written until the maintainer approves this
design (the issue's design gate). Companion: #283
([`2026-11-07-checkpoint-git-isolation-design.md`](./2026-11-07-checkpoint-git-isolation-design.md))
changes the Git environment of the same checkpoint commands and lands first.

## Outcome

1. A file restore (a checkpoint revert that restores files) is refused while any other
   thread sharing the checkout is running a turn: a chat panel, a side chat, or another
   thread on the project root. The refusal names that thread and offers a
   conversation-only rewind.
2. If other threads in the checkout ran turns since the target checkpoint, the dialog
   says so and lists the files they changed before anything happens.
3. From the moment the restore's checks start until the restore finishes, no turn of any
   thread in that checkout starts. A message sent meanwhile waits and is delivered after.
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

- **Checkout**: the directory a thread's Git commands run in. Its key is the lexically
  normalized `worktree_path` of the thread, or the project's `workspace_root` when the
  thread has none (the stored half of `resolve_thread_workspace`, `:1153-1175`). Both the
  fence and the sibling query use this stored key, so they always agree.
- **Siblings**: every other non-deleted thread of the project with the same checkout key:
  the host's panels and side chats, and plain threads without a worktree on the project
  root.
- **File restore**: any revert that runs `restore_checkpoint`, including a `FilesOnly`
  provider's.
- **Writing sibling**: a sibling whose session holds a turn (`session_holds_a_turn`), whose
  live session runs recent background work (the supervisor's `has_recent_live_activity`),
  or whose last turn still has a checkpoint hold (its capture would record restored files
  as its own end state).

## Alternatives

| Option                                                                                                                                                              | For                                                                                                                                             | Against                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (A) Sibling-busy check in `plan_revert` only                                                                                                                        | Small.                                                                                                                                          | The race above.                                                                                                                                                               |
| (B) The revert also takes every sibling's `ThreadTurnFence`, in thread-id order                                                                                     | Reuses one fence.                                                                                                                               | The sibling set is read before locking, so a panel created meanwhile is not covered. Locking N mutexes needs a global order against deliveries and compactions that take one. |
| (C) Wait for running sibling turns to finish                                                                                                                        | No refusal.                                                                                                                                     | A turn can run for an hour. Holding admission that long stalls every chat in the checkout, and the issue asks for a refusal.                                                  |
| **(D) recommended:** a per-checkout read/write gate. Deliveries hold it shared; a file restore holds it exclusive, and refuses (does not wait for) writing siblings | Covers threads created later, because the key is the path. No lock order between threads. Waits only for deliveries in flight, which are short. | One more fence and one stored-key lookup per delivery.                                                                                                                        |

## Decision: option (D)

### Data shapes and state owner

`OrchestrationEngine` owns a `CheckoutTurnFence`, beside `ThreadTurnFence` and like it in
memory only: `StdMutex<HashMap<PathBuf, Weak<tokio::sync::RwLock<()>>>>`.

```rust
pub(crate) struct CheckoutTurnAdmission { _guard: OwnedRwLockReadGuard<()> }   // a delivery
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

Every holder takes the thread gate first and the checkout gate second, and nothing holds a
checkout gate while waiting for a thread gate.

**Delivery** (`prepare_claim_and_deliver`) runs bootstrap first, because the worktree may
not exist before it. It then takes the thread reservation (`:1673`), then checkout
admission (shared), then claims and delivers. Both guards drop when the provider has the
turn, as today. Bootstrap dispatches the new worktree path as thread metadata and awaits
it (`turn_delivery.rs:1734-1750`) before the reservation, so the first delivery of a new
worktree thread already keys on the worktree.

**File restore** (`ParkedThreads::run`, reordered):

1. Thread reservation (`:975`, unchanged, taken first so a later message cannot overtake).
2. Preparation permit, then `plan_own_revert`: today's own-thread checks, target
   resolution and `prepare_provider_rewind` (`:1868-1967`). Nothing here depends on
   siblings, so a cold provider start stays outside the checkout gate.
3. Release the permit, then `previous.await` (the #129 order).
4. Checkout gate, exclusive, waiting at most `CHECKOUT_RESTORE_ADMISSION_WAIT` (15 s).
5. `plan_shared_checkout` under the gate: list siblings, refuse writing siblings, compute
   sibling changes and compare the caller's acknowledgement, refuse the `HEAD` fallback on
   a shared checkout (below).
6. Hand back to the worker with the plan, the reservation and the `CheckoutRestore`.
7. Worker, `finish_revert`: re-check writing siblings (a provider can start a turn itself,
   outside delivery), then `rollback_provider`, `restore_checkpoint`, refs, outcome.
8. `revert` (`:764-780`) drops the reservation and the `CheckoutRestore`, then `resume`
   drops `done` (`:1009-1010`) so the checkout's next revert may proceed.

**What the gate covers.** The issue asks that admission be coordinated "from the moment
the restore is planned". This design holds the gate from the shared-checkout checks
(step 5) through completion (step 8), and not during steps 1 to 3. Step 2 can include a
cold provider start, and holding the gate there would stall every sibling's delivery for
that long. A sibling turn that starts during steps 1 to 3 is still safe: step 5 sees it
as a writing sibling and refuses, before anything is rewound or restored. So no sibling
turn starts between the checks that decide the restore and the restore's end, and a
sibling turn that started earlier makes the restore refuse. The maintainer should confirm this
reading (question 5).

Why there is no deadlock:

- **Previous revert before the gate.** If revert R2 took the exclusive gate before
  awaiting R1's `done`, R1 could never take it. Step 3 precedes step 4, and R1 drops the
  gate (step 8) before its `done`.
- **No thread gate under a checkout gate.** A delivery waiting at step "checkout
  admission" holds its own thread gate. The restore holding the checkout gate never wants
  that thread's gate, only its own, taken at step 1.
- **Long turns are never waited for.** A running sibling turn holds no gate (a delivery's
  hold ends when the provider has the turn). The restore sees it as a writing sibling and
  refuses.
- **Deliveries in flight are bounded by the wait.** A delivery stuck before its provider
  accepts would otherwise hold the gate shared forever, and the queued writer would then
  block every other sibling's delivery. After 15 s the restore gives up (the queued write
  request is dropped, and waiting readers proceed) and refuses: "Another chat in this
  checkout is starting a turn."
- **Compaction** takes only its thread gate (`orchestration_effects.rs:733-737`) and writes no files; it is
  unaffected.
- **A refused restore still releases everything.** Refusals return `Err` in the plan,
  which goes through the same `revert` and `resume` path, so `done` drops and the next
  revert runs.

Capture and restore still run on the effects worker one at a time. The new gate
coordinates turn admission only; it does not serialize Git.

### Conversation-only rewind

A mode on the existing command, not a new command, so the engine path, outcome events and
MCP wait loop are shared:

- `ThreadCheckpointRevertCommand` and `ThreadCheckpointRevertRequestedPayload` gain
  `mode: "full" | "conversationOnly"`, optional, default `"full"`, and
  `siblingChangesToken: string`, optional. The Rust enum gains the same fields with
  `#[serde(default)]`. Replaying an older event yields `full`, so a projection rebuild is
  unchanged. No migration.
- A conversation-only rewind takes the thread reservation only: no checkout gate, no
  `tails` place (`order` skips it), because it writes no file. It runs today's own-thread
  checks, then `rollback_provider`. A `FilesOnly` answer refuses with nothing changed:
  "Claude can't rewind its conversation, so only a file restore is possible." Then it
  deletes the newer checkpoint refs and dispatches `thread.revert.complete`, as a full
  revert does, plus an info activity `checkpoint.revert.conversation-only`, "Conversation
  rewound, files kept". It never runs `restore`, `clean` or `reset`.
- Side chats stay refused by the engine (`engine.rs:5290-5302`) in both modes; a side
  chat has no checkpoints to rewind to.
- The next turn's diff runs from the target's ref, so it also shows the changes the rewind
  kept. Diffs in a shared checkout already include whatever changed between two turns, so
  this is consistent; the activity says the files were kept.

### The sibling-change warning

Under the gate the restore lists **sibling turns since the target**:

- the target's time is the target checkpoint row's `completed_at`; for turn 0 (ref 0,
  captured just before the first turn was claimed) it is turn 1's `started_at`, or its
  `requested_at` when that is null;
- every `projection_turns` row of a sibling with `completed_at` after that time counts;
- a row with a `ready` checkpoint, `diffAvailable`, and an empty file list is left out (it
  changed nothing); its file list is shown otherwise. A side chat's turns have no
  checkpoint, so they count with "files not known".

`siblingChangesToken` is the hex SHA-256 of the sorted `threadId/turnId` list, or absent
when the list is empty. The restore proceeds only if the list is empty or the command's
token equals it. Otherwise it refuses, and the refusal carries the token. A sibling turn
that finishes after the person confirmed changes the token, so a stale confirmation never
discards it.

### Turn 0 on a shared checkout

When ref 0 is missing, turn 0 falls back to `HEAD` (`:1920-1922`). With `clean -fd` that
discards every uncommitted change in the checkout, including idle siblings' work the guard
does not otherwise see. With at least one sibling, the fallback is refused: "This thread
has no starting checkpoint, and other chats share this checkout, so restoring files would
discard their work. Rewind only the conversation, or revert to a later turn." A thread
alone in its checkout keeps today's fallback.

### Pre-dispatch read: `orchestration.previewCheckpointRevert`

Worker refusals land after dispatch as activities, and the native confirm dialog has only
two unnamed buttons. "Warn first" and "offer a conversation-only rewind" therefore need a
read before the dialog:

```ts
// packages/contracts/src/orchestration.ts
previewCheckpointRevert: "orchestration.previewCheckpointRevert"
input:  { threadId, turnCount }
output: {
  writingSiblings: Array<{ threadId, title, reason: "turn" | "backgroundWork" | "checkpointPending" }>,
  siblingChanges: Array<{ threadId, title, turns: number, files: string[] | null }>,
  siblingChangesToken: string | null,
  conversationRewind: boolean,      // the thread's provider supports it
  headFallbackRefused: boolean,
}
```

It reads the database and the supervisor's in-memory sessions, no Git, so it is not
long-running. It is advisory: the worker repeats every check under the gate.

`OrchestrationEffectCallbacks` gains `thread_writes_checkout(thread_id) -> bool`, which
the supervisor answers from `session_holds_a_turn` and `has_recent_live_activity`. Both
the preview and the worker use it.

### UI copy (checked against `UI.md`)

The native confirm is replaced by the app's alert dialog (`AlertDialog`, already used in
`ProjectScriptsControl.tsx` and `settings/WebhooksTab.tsx`) with named buttons. No em
dashes in our copy; thread titles are shown as they are.

Normal revert, provider can rewind:

> **Revert to checkpoint 3?**
> Files go back to how they were after turn 3, and newer messages in this thread are
> removed. This can't be undone.
> [**Revert files and conversation**] (destructive, primary) [Rewind conversation only] [Cancel]

With sibling changes (one line per thread, at most three files each, then "and N more"):

> Other chats in this checkout changed files since then. Reverting files undoes these too:
> Panel, Codex: 2 turns, `src/app.ts`, `README.md`
> Side chat: 1 turn, files not known

A sibling is writing:

> **Can't restore files right now**
> Panel, Codex is running a turn in this checkout. Stop it or wait for it to finish, then
> revert. You can rewind only this conversation now; files stay as they are.
> [**Rewind conversation only**] [Cancel]

The reason line varies: "is running background work", "is still saving its checkpoint".
When the provider cannot rewind, the second sentence and that button are left out, and
the only button is [Close].

Provider cannot rewind (today's text, now with named buttons):

> **Restore files to checkpoint 3?**
> Claude can't rewind its conversation, so the newer messages stay. This can't be undone.
> [**Restore files**] [Cancel]

The **Revert to this message** control stays enabled while a sibling is busy: the dialog
explains why the file restore is unavailable and offers the alternative, instead of a
disabled button that cannot.

Worker refusals (`checkpoint.revert.failed` detail, and MCP `McpCheckpointRevertError`):

| Case                         | Detail                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Writing sibling              | "Another chat in this checkout (Panel, Codex) is running a turn. Stop it or wait for it to finish, then revert, or rewind only the conversation." |
| Gate wait expired            | "Another chat in this checkout is starting a turn. Try the revert again in a moment."                                                             |
| Unacknowledged changes       | "Other chats in this checkout changed files since turn 3. Review them and revert again." (carries the token)                                      |
| `HEAD` fallback refused      | as above                                                                                                                                          |
| Conversation-only, no rewind | "Claude can't rewind its conversation, so only a file restore is possible."                                                                       |

### MCP

`revert_thread_to_turn` gains `mode` (`"full"` default, `"conversationOnly"`) and
`siblingChangesToken`. Its pre-check calls the same preview. An unacknowledged change
returns `McpSharedCheckoutChangedError` with the sibling list and the token in structured
content; the agent repeats the call with the token. A writing sibling returns
`McpTurnRunningError` naming the sibling.

## Failure, restart and concurrency

- **Restart.** Both gates and `restore_holds` are in memory. That is sound for the reason
  `ThreadTurnFence` gives (`engine.rs:1793-1796`): the worker never replays a revert
  requested before a restart. A restore interrupted by a crash leaves the checkout part
  restored, as today; the person reverts again.
- **Shutdown.** The waiter's `select!` on cancellation (`:971-987`) drops the guards. Once
  the provider has rewound, the restore is uninterruptible (`:2093-2098`) and holds the
  gate until it is recorded.
- **Provider-started turns.** Claude, Cursor, OpenCode and Grok can start a turn without a
  delivery (`provider_runtime.rs:12950-12957` describes `providerStarted`). The gate cannot
  stop those. Step 7's re-check just before the irreversible rewind narrows the window to
  the rewind's own duration, which remains a known residual.
- **What the guard does not cover.** The person's terminals, editors and agents outside
  BiBCode; a second project registered on the same directory; two spellings of one path
  through a symlink (the key is lexical, as `tails` is today).
- **Mixed versions.** An older client sends no `mode` (full) and no token. It still works
  unless siblings changed files since the target, when the worker refuses with the detail
  above; the work log shows it. An older server ignores the new fields: a newer client
  must not offer **Rewind conversation only** unless the server advertises it, so the
  server adds `conversationOnlyRewind: true` to its environment capabilities
  (`http.rs:752-761`, `:781-788`; contract `ExecutionEnvironmentCapabilities`,
  `environment.ts:30`, default `false`).
- **Performance.** One stored-key lookup per delivery (thread row, project row when the
  thread has no worktree), one `RwLock` acquisition uncontended in the common case. The
  preview runs one sibling query and one turns query per revert dialog.

## Tests, mapped to the acceptance

Acceptance 1, "pauses revert preparation, attempts a sibling turn, and shows the turn is
held or refused until the restore completes":

1. `a_sibling_turn_waits_while_restore_preparation_holds_the_checkout`: a new test hook
   pauses preparation inside the gate, after `plan_shared_checkout` starts (step 5) and
   before the handback (step 6). Send a panel message on the same worktree; assert the
   panel's delivery is not claimed; release; assert the restore finished before the
   panel's claim.
   1b. `a_sibling_turn_waits_until_the_restore_itself_completes`: the same, paused in the
   host's `rollback_provider` (step 7) with the existing `entered`/`release` hooks
   (`turn_delivery_queue_tests.rs:911-938`).
   1c. `a_sibling_turn_started_before_the_gate_makes_the_restore_refuse`: pause in
   `prepare_provider_rewind` (step 2), start a panel turn, release; the restore is refused
   naming the panel, files unchanged, provider not rewound.
2. `a_sibling_turn_already_claimed_makes_the_restore_wait_then_refuse`: hold a panel
   delivery before its provider accepts; request the host restore; release; the restore is
   refused naming the panel, and the files are unchanged.
3. `a_restore_gives_up_after_the_admission_wait`: a delivery that never accepts; the
   restore is refused after the wait (paused clock), and the panel's next delivery is then
   not blocked.
4. `reverts_of_one_checkout_still_restore_in_request_order_under_the_gate` (the #129
   test, extended with a panel delivery in between).
5. `a_thread_on_the_project_root_is_a_sibling_of_another_root_thread`.

Acceptance 2, "a host restore while a panel is busy is refused, with an actionable
message":

6. `a_restore_is_refused_while_a_panel_runs_a_turn`: detail names the panel and the
   conversation-only alternative; files and conversation unchanged; provider not rewound.
7. `a_restore_is_refused_while_a_sibling_runs_background_work`.
8. `a_restore_is_refused_while_a_sibling_checkpoint_is_pending`.
9. `a_provider_started_sibling_turn_after_planning_is_caught_before_the_rewind`.
10. `turn_zero_head_fallback_is_refused_on_a_shared_checkout` and
    `turn_zero_head_fallback_still_works_alone`.

Acceptance 3, "a conversation-only rewind leaves the working tree byte for byte
unchanged":

11. `a_conversation_only_rewind_leaves_the_working_tree_unchanged`: before and after,
    compare every path under the checkout except `.git` (tracked, modified, untracked and
    ignored files, and an empty directory) by bytes, plus `git status --porcelain=v2
    --ignored`. Assert the provider rewound, newer messages and turns are gone, newer refs
    deleted, target ref kept.
12. `a_conversation_only_rewind_runs_while_a_sibling_is_busy`.
13. `a_conversation_only_rewind_is_refused_for_a_files_only_provider`: nothing changes.

Warning:

14. `sibling_changes_need_the_matching_token`: no token refuses with the token; the token
    restores; a sibling turn finishing after the preview changes the token and refuses.
15. `a_sibling_turn_that_changed_nothing_is_not_listed`.
16. Preview RPC: `preview_reports_writing_siblings_changes_and_rewind_support`.

Contracts and web:

17. Contracts: `mode` defaults to `full`; an event without it decodes.
18. `ChatView.logic` tests: dialog model for each case (normal, sibling changes, writing
    sibling with and without rewind support, files-only provider).
19. MCP: `revert_thread_to_turn` with `conversationOnly`, and the token round trip.

## Files to change

- `apps/server/src/orchestration/engine.rs`: `CheckoutTurnFence`, `restore_holds`, the
  command and requested-payload fields.
- `apps/server/src/production/orchestration_effects.rs`: `ParkedThreads::order` and `run`
  (reorder, gate), `plan_revert` split into own and shared parts, `finish_revert`
  (re-check, conversation-only branch), `OrchestrationEffectCallbacks::thread_writes_checkout`.
- `apps/server/src/production/turn_delivery.rs`: shared admission in
  `prepare_claim_and_deliver`; `restore_holds` skips at `:1095` and `:1495`.
- `apps/server/src/production/provider_runtime.rs`: `thread_writes_checkout`.
- `apps/server/src/persistence/repositories.rs`: sibling and sibling-turn queries.
- `apps/server/src/production/orchestration_rpc.rs` and `rpc/session.rs`: the preview
  method through the timing wrapper.
- `apps/server/src/mcp/tools/threads.rs`: `mode`, token, errors.
- `apps/server/src/http.rs`: `conversationOnlyRewind` capability.
- `packages/contracts/src/orchestration.ts`, `environment.ts`; `packages/client-runtime`
  thread commands and the preview query.
- `apps/web/src/components/ChatView.tsx`, `ChatView.logic.ts`: the dialog.
- Living docs: `docs/architecture/rpc-and-orchestration.md` "Checkpoint revert" and the
  MCP section (`:3834-3839`), `docs/user/workspace-ui.md` (revert dialog), the MCP tool
  description. `docs/architecture/overview.md` is coordinator-reserved: one line under
  checkpoints, "A file restore holds its checkout's turn admission and refuses while
  another chat there is writing."

## Profiler, crash and trace coverage

- **RPC methods.** `orchestration.previewCheckpointRevert` is registered through the
  `rpc/session.rs` wrappers, so it is timed. It waits on nothing external, so it is not
  added to `is_long_running`.
- **Logs.** A refused restore already becomes `checkpoint.revert.failed` through
  `append_failure_activity` and `tracing::warn!` (`:782-791`). A gate wait that expires
  logs `tracing::warn!` with the thread id and no path.
- **Not applicable.** Child processes (no new spawn), worktree removal, binaries,
  shutdown order, profiler events.

## Risks

- Delivery gains a dependency on the stored checkout key. A thread whose stored path
  differs from its live session's cwd would be fenced under the stored one. The live cwd
  comes from the same stored path today.
- The 15 s wait is a judgement: long enough for a provider to accept a turn on a loaded
  machine, short enough that a stuck delivery does not freeze the checkout. The test
  uses a paused clock.
- Replacing the native confirm changes a desktop dialog into an in-app one. The in-app
  dialog must keep keyboard focus and Escape behaviour (`AlertDialog` does).

## Questions only the maintainer can answer

1. Should **Rewind conversation only** be offered in every revert dialog (this design), or
   only as the fallback when a file restore is refused?
2. Should the sibling-change warning stay a confirmation (this design: the person sees it
   and confirms), or block the file restore until the siblings' work is committed?
3. Is refusing turn 0's `HEAD` fallback on a shared checkout acceptable, or should it warn
   and proceed?
4. Is 15 s the right bound for waiting on a sibling delivery in flight?
5. Does "coordinated from the moment the restore is planned" accept a gate that starts at
   the shared-checkout checks, with a refusal for any sibling turn that started during the
   thread's own preparation (see "What the gate covers")?
