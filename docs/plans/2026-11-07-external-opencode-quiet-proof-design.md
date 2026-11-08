# Checkpoints: Restore Files Beside a Quiet External OpenCode Server

Status: Approved 2026-11-07 (the maintainer pre-approval; reviewed by Codex and advisor). Issue #326, a follow-up to #279
([`2026-11-07-shared-checkout-restore-guard-design.md`](./2026-11-07-shared-checkout-restore-guard-design.md),
approved, on branch `worktree-agent-acfdd3a967c39b8d0` at the time of writing). BiBCode
line references are to `e222d340ff`. OpenCode references are to the source read for this
note: OpenCode 2 at `anomalyco/opencode` `dev` commit `5a47777cc4c7` (package version 2.2.5,
read 2026-11-07; latest release v2.2.6), and OpenCode 1 at tag `v1.19.5` (commit
`810c0eba1a73`, the newest 1.x tag). Nothing was run against a live OpenCode server for
this note. The file name was assigned before review; the design establishes quiet only
through the person's statement (see Outcome).

**Implementation notes (2026-11-08).** Implemented in `provider/opencode/quiet.rs`. Choices
made where this note left them open, checked against the OpenCode 2 source above:
`/api/shell` and `/api/pty` take `location[directory]` (`LocationQuery`), so they are listed
for the checkout. The shell list holds only running commands, so any entry refuses. An exited
PTY is kept until removed, writes nothing, and does not refuse. The session, job, schedule,
inbox and form routes are read without a location, as the adapter reads them. A schedule
refuses only while `active` (`paused` and `done` cannot fire). Fences ride on `SharedRestore`
in the revert plan, not on `CheckoutRestore` (outside this lane); they drop at the same
points. `quiet_sibling` also takes a `QuietRestore` carrying the reverting thread, the
checkout and the shared deadline. `exclusiveServer` is read from the instance `config` only:
the legacy `providers.opencode` patch was left unchanged, since nothing on the server reads
the flag there. After review, the Copy table's "Panel's OpenCode server" became "the
OpenCode server that "Panel" uses", because real titles such as "Panel, Codex" made the
possessive ambiguous. The unmanaged refusal now reads: ""Panel" uses an OpenCode server that
other apps may also use, so BiBCode can't make sure it has stopped working in this checkout.
Rewind only the conversation instead. If only BiBCode uses that server, turn on "Only BiBCode
uses this server" in Settings → Providers → OpenCode." The fence is also checked once more
after step 7's tree capture, immediately before the provider rewind.

**Revision 1 (2026-11-07)** records the maintainer's answers (see
[Decisions recorded](#decisions-recorded)) and answers Codex's review of `ac16d0da05`
(see [Review findings and resolutions](#review-findings-and-resolutions)). It reframes the
probe and fence as best-effort detection, widens the statement to cover schedules and
plugins, probes schedules per session, exempts the reverting session's own rewind, and
makes 10 s the total probe budget.

## Outcome

#279 refuses every host file restore in a checkout while another chat there (a "sibling")
uses an OpenCode instance with `serverUrl` set (an "unmanaged sibling"). BiBCode does not
own that server, and suspending BiBCode's session only stops observing it. The issue asks:
if OpenCode's API can show the sibling's session idle and unable to start work by itself
for the restore's duration, restore; otherwise keep refusing.

**Finding: OpenCode's API cannot establish that.** Neither version has a lock, pause or
prompt-admission control. Any other client of the server (TUI, web UI, another app), any
schedule and any plugin can start work at any moment, with no prior signal. A client can
only see "nothing is running or pending right now" and watch for a start afterwards, and
even that watch lags: OpenCode 2 registers an execution before its start event is
published and delivered (`core/src/session/run-coordinator.ts` L82-95), and the stream's
heartbeat is an independent 15 s timer (`server/src/handlers/event.ts` L18-25), so a start
registered just before the last check can still be in transit while Git runs.

**Decision:** keep #279's refusal as the default. Lift it only for an OpenCode 2 instance
where the person turns on a new per-instance setting stating that nothing but BiBCode
starts work on that server. **That statement is the guarantee.** The probe (the sibling's
session tree is idle with nothing pending) and the event-stream fence (checked before each
irreversible step) are best-effort detection of a false statement: they refuse or report
what they see, and cannot exclude a start they do not see. Anything the probe cannot read
refuses. OpenCode 1 keeps refusing. The maintainer accepted this, knowing the residual risk is a
false statement.

## Decisions recorded

The maintainer, 2026-11-07, through the coordinator:

1. The opt-in `exclusiveServer` statement is accepted as the basis for lifting the
   refusal; the residual risk is a false statement.
2. OpenCode 2 only. OpenCode 1 external servers keep refusing.
3. The refusal for an unmanaged sibling names the "Only BiBCode uses this server" setting.
4. The probe budget of 10 s is accepted (total across siblings, below).

## What OpenCode's API offers (verified in source)

| Need                   | OpenCode 2 (`/api/*`)                                                                                                                                                                                                                                                                                                                                                                                                                       | OpenCode 1                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is it running now      | `GET /api/session/active`: a flat map of session id to `{type:"running"}` for executions **owned by this server process** (`packages/protocol/src/groups/session.ts` L41-43, L220-230). Retry backoff, compaction and permission or question waits stay inside the execution, so they show as running (`core/src/session/runner/retry.ts` L57-77, `runner/llm.ts` L245-252, `form.ts` L152-157).                                            | `GET /session/status`: `{id: busy \| retry}`, idle ids omitted, so an unknown id also looks idle (`opencode/src/session/status.ts` L28-47). The map is **per directory**: it uses `?directory=`, then `x-opencode-directory`, then the server's cwd. A wrong directory returns `{}` (`middleware/workspace-routing.ts` L86-88, L175-183). |
| Is work pending        | Unconsumed background jobs, children included: `GET /api/experimental/job?sessionID=&descendants=true`. A finished child's row stays until its result is admitted to the parent (`protocol/src/groups/job.ts` L12-44, `core/src/session/subagent-completion.ts` L37-45). Parked input: `GET /api/session/{id}/inbox` (`session.ts` L540-552). Pending forms: `GET /api/session/{id}/form`. Both job and log routes are marked experimental. | None found. Background subagents (behind `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`) re-prompt the parent after the child ends, with no listing route.                                                                                                                                                                                  |
| Durable hint           | `GET /api/session/{id}`: `time.busy` after `time.idle` means an execution started without a terminal event, including one left by a crash (`schema/src/session.ts` L44-49, `core/src/session/projector.ts` L840-861).                                                                                                                                                                                                                       | None.                                                                                                                                                                                                                                                                                                                                     |
| Stop                   | `POST /api/session/{id}/interrupt` acknowledges before cleanup, one session only, and does not block a later prompt (`session.ts` L672-690, `execution.ts` L151-168).                                                                                                                                                                                                                                                                       | `POST /session/{id}/abort` always returns `true`; it does not block a later prompt (`handlers/session.ts` L232-235).                                                                                                                                                                                                                      |
| Lock, pause, admission | None. The only pause is per schedule, `POST /api/experimental/schedule/{id}/pause` (`protocol/src/groups/schedule.ts` L47-52). A prompt is admitted whenever the session exists (`session.ts` L337-357).                                                                                                                                                                                                                                    | None. The per-session runner lock is internal; only revert, unrevert and message delete check it.                                                                                                                                                                                                                                         |
| Event stream           | `GET /api/event`, global across directories, `server.connected` first, heartbeat every 15 s, frames carry no `id:`, no `Last-Event-ID`, no replay, and a 4096-frame queue that **fails** the stream on overflow (`server/src/handlers/event.ts` L10-37, `server/src/event-feed.ts` L8, L29-31, L66-78). Start and end: `session.execution.started` / `succeeded` / `failed` / `interrupted` (`schema/src/session-event.ts` L244-264).       | `GET /event?directory=` (one directory) and `/global/event`, `server.connected` first, heartbeat every 10 s, no SSE `id`, no replay. `session.status` and `session.idle`; `idle` is published before the runner finishes unwinding (`session/status.ts` L38-44, `processor.ts` L626-638).                                                 |
| Server identity        | `GET /api/info` carries the process `pid` (`protocol/src/groups/server.ts` L5-8, L45-50).                                                                                                                                                                                                                                                                                                                                                   | None beyond `server.connected` on reconnect.                                                                                                                                                                                                                                                                                              |

BiBCode already reads the first row: `session_still_working` (`provider/opencode/runtime.rs:1372-1392`)
asks `/api/session/active` or `/session/status`, and treats a server without the route as
idle (`:1340`). That default is right for delivery deduplication and wrong for a restore.

### What starts work with no prompt from BiBCode

| Starter                                                     | Visible beforehand?                                                                                               | Source                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Prompt from another client (TUI, web, app, ACP)             | **No.**                                                                                                           | v2 `session.ts` L155-191; v1 `prompt.ts` L1052-1070                             |
| Plugin event handler or plugin RPC admitting input          | **No**, and installed plugins cannot be enumerated for this purpose.                                              | v2 `core/src/plugin/host.ts` L592, `plugin/command.ts` L70                      |
| Background subagent finishing                               | v2: child in `/active`, then a job row until delivered. v1: child busy, then a gap before the parent is prompted. | v2 `subagent-job.ts` L45-62, `subagent-completion.ts` L21-45; v1 `tool/task.ts` |
| Background shell or image job finishing (also writes files) | v2: job row `kind: shell`, which outlives the session's execution.                                                | v2 `tool/plugin/shell.ts` L144-176, `session/background.ts` L30-40              |
| Retry, auto-compaction, `/goal` continuation                | Inside a running execution, so visible as running.                                                                | v2 `retry.ts` L57-77, `llm.ts` L175-186; v1 `retry.ts`, `prompt.ts` L1146-1170  |
| Scheduled prompt (v2.2, `experimental.schedules`)           | Rows in `GET /api/experimental/schedule` with `next_due_at`.                                                      | v2 `core/src/schedule.ts` L272, L431-452                                        |
| Server restart resuming a claimed execution                 | `time.busy` after `time.idle`; the event stream drops and the `pid` changes.                                      | v2 `session/execution/restart.ts` L36-64, L221-258                              |
| Executions in another OpenCode process sharing the database | **No.** `/api/session/active` covers this process only.                                                           | v2 route description, `schedule.ts` L76-79                                      |

Non-execution writers can also change files while every session is idle: a user shell
(`POST /api/session/{id}/shell`, outside the execution coordinator, `session.ts` L192-235),
terminals (`/api/shell`, `/api/pty`, persistent PTYs; v1 `/pty`), and the file API
(`POST /api/experimental/fs/write`). All are started by a client.

Three rows say **No**. Those starters are only excluded if nobody else uses the server,
which BiBCode cannot check. That is why the guarantee has to be the person's statement.

## Options

| Option                                                                                                             | For                                                                                                                               | Against                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(A)** Keep #279's refusal. Improve the copy to name the fix (clear Server URL so BiBCode starts its own server). | No code, no risk. Correct by the evidence above.                                                                                  | The issue's case stays blocked. The maintainer's workflow with a long-running external server keeps only "Rewind conversation only".                                         |
| **(B)** Probe automatically for every unmanaged sibling.                                                           | No setting.                                                                                                                       | No guarantee: another client's prompt, a plugin or another process can start work unseen. A restore would overwrite that work. Breaks the issue's "otherwise keep refusing". |
| **(C) chosen:** (B) only for an instance marked "Only BiBCode uses this server", OpenCode 2 only.                  | A true statement leaves only starters the probe can see. The probe and fence catch some false statements. The default stays safe. | Rests on a statement BiBCode cannot verify. One setting field (a contracts schema change). Uses experimental OpenCode 2 routes, so a server without them refuses.            |
| **(D)** Interrupt the sibling's session before restoring.                                                          | Stops a running turn.                                                                                                             | Interrupt is not a lock; work can start again at once. Destroys the sibling's work instead of protecting it.                                                                 |
| **(E)** Ask in the revert dialog each time ("I'm sure nothing else uses this server").                             | No setting.                                                                                                                       | Asks a question the person cannot answer at revert time (UI.md: match the mental model, safe defaults). A habit-forming checkbox in front of an overwrite.                   |
| **(F)** Stage a revert on the sibling's OpenCode session to block background wake-ups.                             | OpenCode 2 skips synthetic wakes while a revert is staged (`session.ts` L323).                                                    | A user prompt still wakes and commits the staged revert (`session.ts` L173). It mutates the sibling's conversation. Incidental behaviour, not a contract.                    |

Option (C) costs one setting and one probe module; (A) remains its fallback in every
failure path.

## Decision: option (C)

### The statement

A new boolean in `OpenCodeSettings` (`packages/contracts/src/settings.ts:490-530`),
`exclusiveServer`, default `false`, shown after `serverPassword`:

- Title: "Only BiBCode uses this server"
- Description: "Turn on only if nothing else starts sessions or sends prompts on this
  server: no OpenCode TUI or web page, no other app, no schedule, and no plugin that starts
  work on its own. BiBCode then restores files in a checkout while another chat uses this
  server, and refuses if it sees the server working."

**What a true statement excludes.** Every starter in the table above that is not a
continuation of a BiBCode chat's own work: other clients' prompts (including another
OpenCode process on the same database, which is another app), schedules, and plugins that
admit input on their own. **What it does not need to exclude**, because the work belongs
to a BiBCode chat and the probe sees it: retries and compaction (inside a running
execution), a `/goal` continuation (inside the execution, or woken by a background job the
probe lists), background subagent, shell and image results (job rows), and a restart
resuming a claimed execution (`time.busy` after `time.idle`, a changed `pid`). BiBCode
itself creates no OpenCode schedules. With a true statement, every remaining starter is
visible to the probe before the restore; the fence is a last check, not the guarantee.

It has no effect when `serverUrl` is empty: a BiBCode-started server is already managed,
and #279 suspends its siblings. The provider instance resolution that reads `serverUrl`
(`production/provider_runtime.rs:6221-6222`, `:6559-6562`) carries the flag next to it.

### The probe (OpenCode 2 only)

Best-effort detection, not a guarantee. Run for each unmanaged sibling whose instance has
`exclusiveServer`, after #279 has suspended BiBCode's session for it. It is a short-lived
client separate from any runtime, with the instance's URL and password, each request
bounded by the existing `DELIVERY_LOOKUP_TIMEOUT`. **One 10 s budget covers every probe of
one restore, across all siblings**; when it runs out the restore refuses ("BiBCode can't
read whether Panel's OpenCode server is idle"). Steps, in this order:

1. `GET /api/info`. Not OpenCode 2 → refuse. Keep the `pid`.
2. **Open the fence:** `GET /api/event`, and wait for `server.connected`. A start
   published after this frame reaches the fence, but possibly after a delay (see Races).
3. Find the tree: the root session id from the sibling's persisted runtime (the
   `resume_cursor` / `runtime_payload` that `suspend_idle_session` keeps,
   `provider_runtime.rs:13015-13030`; the implementer confirms which field holds it). The
   descendants from `GET /api/session?parentID=` walked to a fixed depth (the adapter
   already does this for activity, `v2_activity.rs:296-322`), plus the session ids named
   by step 5's job rows. Every probe request sends the instance's directory the way the
   adapter does (`location[directory]`, `runtime.rs:4585-4603`). Some OpenCode 2 routes
   are location-bound (`prompt` is, `/api/session/active` is not); a wrong location could
   hide children. The implementer confirms which probe routes are location-bound and pins
   that with a test.
4. `GET /api/session/active`: any tree id present → refuse ("is working").
5. `GET /api/experimental/job?sessionID=<root>&descendants=true`: any row → refuse.
6. For each tree session: `GET /api/session/{id}/inbox` and `/form` empty, and
   `GET /api/session/{id}` with `time.busy` not after `time.idle`. A session with neither
   time has never run and counts as idle. Otherwise refuse.
7. For each tree session: `GET /api/experimental/schedule?sessionID=<id>`. Listing is per
   session (`sessionID` is required, `protocol/src/groups/schedule.ts` L37-41). A
   `ForbiddenError` carrying the schedules-disabled message (`server/src/handlers/schedule.ts`
   L14-17, L74-75) means none. Any schedule that is not paused → refuse. Any other error →
   refuse.
8. `GET /api/shell` and `GET /api/pty`: their response shape was not verified for this
   note. If entries carry a directory, refuse on one inside the checkout; if they do not,
   refuse on any entry. Any error → refuse.

Any 404, non-JSON answer, timeout or unexpected shape at any step refuses: "BiBCode can't
read whether Panel's OpenCode server is idle." A missing experimental route never counts
as safe. The probe never sends a prompt, interrupt or revert to the sibling's session.

The probe returns a `QuietFence`: the open stream, the tree ids, the checkout path and the
`pid`. The fence **trips** on any of:

- `session.execution.started`, `session.inbox.enqueued`, `session.synthetic`,
  `session.shell.started` or `session.revert.staged` for a tree id;
- the same events for any other session whose `location` is inside the checkout, or that
  carries no `location`, **except** the reverting thread's own OpenCode session's rewind:
  `session.revert.staged` and `session.revert.committed` for that session id, which BiBCode
  itself sends through `revert/stage` and `revert/commit` (`provider/opencode/runtime.rs:4185-4199`;
  OpenCode publishes `staged` from `core/src/session/revert.ts` L50-54). The probe is
  given that session id when the reverting thread runs OpenCode 2 on the same server. Any
  other event from that session (an execution start) still trips;
- a second `server.connected`, the stream ending or failing (overflow fails it), or no
  bytes for 20 s. OpenCode 2's heartbeat is an SSE comment (`: heartbeat`, every 15 s),
  which the adapter's decoder (`provider/opencode/sse.rs`) yields as no data, so the fence
  counts any chunk read from the body as liveness, not only decoded frames.

`QuietFence::check()` returns `Err` once tripped, and also re-reads `GET /api/info` and
trips on a changed `pid`. Dropping the fence closes the stream.

### Races, and what covers each

| Race                                                                                                               | Covered by                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A start between the status reads and the restore.                                                                  | **The statement.** Detection is best effort: the fence opens before the reads (step 2), and a start registered before a read is listed in `/active`. But an execution is registered before its start event is published (`run-coordinator.ts` L82-95), so a start registered just before the last `check()` can still be in transit while Git runs. The heartbeat is an independent timer (`handlers/event.ts` L18-25) and does not flush pending events. |
| A child finished but its result is not yet admitted to the parent.                                                 | Step 5: the job row stays until the result is admitted.                                                                                                                                                                                                                                                                                                                                                                                                   |
| A background shell keeps writing after its session went idle.                                                      | Step 5 (`kind: shell` row) and step 8.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Events missed while disconnected (no replay).                                                                      | A disconnect, a second `server.connected` or a silent stream trips the fence.                                                                                                                                                                                                                                                                                                                                                                             |
| The server restarts and resumes a claimed execution.                                                               | Step 6 (`time.busy` after `time.idle`), and a restart drops the stream and changes the `pid`.                                                                                                                                                                                                                                                                                                                                                             |
| A start seen after the provider rewind (irreversible) but before `restore_checkpoint`.                             | A second check immediately before `restore_checkpoint` (below). The Git restore is what would overwrite sibling work, so it is skipped and the revert ends through the existing unrestored completion.                                                                                                                                                                                                                                                    |
| A start during `restore_checkpoint` itself (`restore`, `clean -fd`, `reset`).                                      | Not preventable. Under a true statement there is no unseen starter left; a trip here is reported after the restore so the person can check that chat's files.                                                                                                                                                                                                                                                                                             |
| Another client's prompt, a schedule, a plugin, another process on the same database.                               | **Only the statement.** The probe may see such work and refuse; the fence may see a later start and report it. Neither excludes it.                                                                                                                                                                                                                                                                                                                       |
| The reverting thread's own rewind on the same server publishes `session.revert.*` in the checkout.                 | Exempted by session id and event type (fence rules above).                                                                                                                                                                                                                                                                                                                                                                                                |
| OpenCode 2 location-bound routes answer for the wrong directory.                                                   | The probe sends the adapter's location; a test pins which routes need it (step 3).                                                                                                                                                                                                                                                                                                                                                                        |
| OpenCode 1: wrong-directory `{}`, `idle` before the runner ends, `prompt_async` 204 before `busy`, no job listing. | Not attempted: OpenCode 1 keeps refusing.                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Hook into the #279 guard

#279's shared-checkout checks run in `plan_revert` (step 5) and again on the worker before
the rewind (step 7). Its callback `quiet_sibling(thread_id) -> Result<(), WritingReason>`
refuses every unmanaged sibling. Changes:

1. `quiet_sibling` returns `Result<Option<QuietFence>, WritingReason>`. For an unmanaged
   sibling it first suspends BiBCode's session as for any sibling (so the sibling's own
   reopen is held by `restore_holds`), then:
   - without `exclusiveServer`, or on OpenCode 1: today's refusal, unchanged;
   - otherwise: run the probe; `Ok(Some(fence))` or the probe's refusal.
2. `CheckoutRestore` gains `quiet_fences: Vec<QuietFence>`. The fences ride with it to the
   worker and close when it drops (#279 step 8), on success and on every refusal.
3. #279 step 7 repeats checks 2 and 3. For a fenced sibling it does not run
   `quiet_sibling` or the probe again; it calls `check()` on the fence, before
   `rollback_provider`. A trip refuses with nothing changed.
4. New check point in `finish_revert`, immediately before `restore_checkpoint`
   (`orchestration_effects.rs:2023-2165`): a tripped fence skips the Git restore and
   takes the existing unrestored completion (`orchestration_effects.rs:2090-2163`): once
   the provider has rewound, the revert is still recorded with `ThreadRevertComplete` and
   the error reads "The conversation was rewound, but the files could not be restored: …",
   with the trip message as the cause. The person reverts again.
5. After `restore_checkpoint`, one last `check()`; a trip adds a warning to the revert's
   outcome activity. It does not undo the restore.
6. The pre-dispatch preview (`orchestration.previewCheckpointRevert`, #279) shows an
   unmanaged sibling as blocking only when the instance lacks the statement. A
   statement-marked sibling shows nothing in the preview; the probe runs at the restore.

**Fence lifetime.** The fence opens in step 5 and closes when `CheckoutRestore` drops in
step 8. In between run `prepare_provider_rewind` (possibly a cold start of the reverting
thread's provider, tens of seconds), the hand-off to the worker, the provider rewind and
the Git restore. The heartbeat rule above keeps a quiet fence alive through all of it.

The probe holds no BiBCode lock beyond what #279 already holds at steps 5 and 7, and takes
no thread or checkout gate, so #279's lock order is unchanged. It adds at most 10 s in
total to step 5, inside the checkout gate. #279's 15 s `CHECKOUT_RESTORE_ADMISSION_WAIT`
bounds only acquiring the gate, not how long it is held, so deliveries waiting behind the
gate wait up to the probe budget longer, on top of #279's existing hold.

### Copy (checked against `UI.md`)

| Case                                   | Message                                                                                                                                                                                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unmanaged, no statement (extends #279) | "Panel, OpenCode runs on an OpenCode server BiBCode doesn't manage, so BiBCode can't make sure it has stopped working in this checkout. Rewind only the conversation instead. If nothing but BiBCode uses that server, turn on Only BiBCode uses this server in Settings → Providers → OpenCode." |
| OpenCode 1 with the statement          | "Panel's OpenCode 1 server can't report whether it's idle. Rewind only the conversation instead."                                                                                                                                                                                                 |
| Probe sees work                        | "Panel's OpenCode server is still working in this checkout. Try the revert again when it finishes."                                                                                                                                                                                               |
| Probe cannot read                      | "BiBCode can't read whether Panel's OpenCode server is idle. Rewind only the conversation instead."                                                                                                                                                                                               |
| Trip before `restore_checkpoint`       | The existing unrestored error with this cause: "The conversation was rewound, but the files could not be restored: Panel's OpenCode server started working. Revert again when it finishes."                                                                                                       |
| Trip after `restore_checkpoint`        | "Files were restored, but Panel's OpenCode server started working during the restore. Check Panel's changes."                                                                                                                                                                                     |

The maintainer's decision 3: the refusal names the setting. Its condition ("If nothing but BiBCode
uses that server") comes first so the sentence states what the setting asserts before
where to find it, rather than offering it as a way past the dialog.

## Tests

A scripted OpenCode 2 server in Rust (axum, as in `provider/opencode/v2_runtime_tests.rs`,
which already scripts `/api/*` routes and the event stream from fixtures). Each test sets
the routes' answers and pushes events on cue, and records every request.

Probe unit tests (`provider/opencode`, new module):

1. Idle tree, empty jobs, inboxes, forms, schedules and terminals → `Ok(fence)`; the server
   saw no prompt, interrupt or revert request.
2. Root id in `/api/session/active` → refused, "still working".
3. Job row present while `/active` is empty → refused.
4. Non-empty inbox; pending form → refused.
5. `time.busy` after `time.idle` → refused.
6. Schedules, queried once per tree session with `sessionID`: an enabled schedule on a
   child → refused; a paused one → passes; the schedules-disabled `ForbiddenError` → passes;
   a 404 or any other error → refused.
7. Terminal inside the checkout → refused; outside it → passes; route 404 → refused.
8. Job route 404 (an older 2.x) → refused, "can't read".
9. A route that never answers → refused within the budget. Two marked siblings whose
   probes together exceed 10 s → refused when the shared budget runs out, not after 20 s.
10. OpenCode 1 server (`/global/health` JSON, `/api/info` absent) → refused before any
    session read.
11. Fence: `session.execution.started` for a tree id → trips; for a session located in
    another directory → does not trip; with no location → trips.
12. Fence: second `server.connected`, stream closed, stream silent for 20 s, `pid` changed
    at `check()` → each trips.
13. Dropping the fence closes the connection (the server sees it end).
14. Fence: `session.revert.staged` and `session.revert.committed` for the reverting
    session id → do not trip; `session.execution.started` for that id → trips;
    `session.revert.staged` for a tree id → trips.

Guard tests (on top of #279's tests, same module as its 12c):

15. `a_declared_exclusive_idle_opencode_sibling_allows_the_restore`: files restored.
16. `the_reverting_threads_own_opencode_rewind_does_not_trip_the_fence`: the reverting
    thread runs OpenCode 2 on the same scripted server as the marked sibling; its
    `revert/stage` and `revert/commit` publish `session.revert.*` in the checkout; files
    are restored.
17. #279's 12c still passes for an instance without the statement, now with the message
    that names the setting.
18. `a_sibling_execution_after_planning_refuses_before_the_rewind`: the event arrives
    between step 5 and step 7 → refused, no provider rewind, no file changed.
19. `a_sibling_execution_after_the_rewind_skips_the_file_restore`: the event arrives after
    `rollback_provider` → `ThreadRevertComplete` recorded, files untouched, the unrestored
    error with the trip message.
20. `a_refused_restore_closes_every_quiet_fence`: the scripted server sees each stream end
    on refusal and on success.

Live check for the execution report, against a real OpenCode 2.2.x server with the
scripted model already used by `v2_runtime_tests.rs:1216`: an idle sibling restores; a
sibling with a running background subagent (the two-second shell at `:1697`) refuses.

## Files to change (later lane)

- `packages/contracts/src/settings.ts`: `exclusiveServer` in `OpenCodeSettings` and its
  patch shape (`:737`).
- `apps/server/src/provider/opencode/quiet.rs` (new): probe and `QuietFence`.
- `apps/server/src/production/provider_runtime.rs`: carry the flag; `quiet_sibling`
  returns the fence.
- `apps/server/src/production/orchestration_effects.rs`: fences on `CheckoutRestore`, the
  two new check points in `finish_revert`, the new messages.
- Settings form: no code if the generic provider form renders the new key; otherwise the
  OpenCode settings section in `apps/web`.
- Docs: `docs/architecture/rpc-and-orchestration.md` (checkpoint revert), the OpenCode
  provider reference, and `docs/testing/` if the live check joins a runbook.

## Profiler, crash and trace coverage

No new child process and no new RPC method. The probe is network I/O on the effects
worker inside an existing revert. Log each refusal reason with `tracing::info!` and each
trip with `tracing::warn!`, with the instance id and session ids, never prompt or message
content. If `checkpoint.revert` timing is profiled today, the probe's time falls inside
it; no new event or finding.

## Risks

- **A false statement overwrites work.** This is the accepted residual risk. If another
  client, schedule or plugin starts work on a server marked exclusive, a start whose event
  is still in transit at the last `check()`, or one during `restore_checkpoint`, can lose
  that turn's file changes. The probe and fence only detect what they see.
- **Experimental routes.** Jobs, schedules and the event vocabulary may change in OpenCode
  2 minor releases. Every unreadable answer refuses, so drift makes the guard stricter,
  not looser. The fixture-based tests pin today's shapes.
- **Source read once.** OpenCode behaviour above is from one `dev` commit (2.2.5) and the
  v1.19.5 tag; 2.0.x and 2.1.x were not diffed. The live check covers the version the maintainer
  runs.
- **Unverified items** carried from the research: whether v2 permission and question waits
  always sit inside the execution (inferred from `form.ts`); whether interrupt cancels every
  descendant's jobs; a possible lost prompt at OpenCode 1's loop exit. None changes the
  decision, because OpenCode 1 refuses and the probe does not interrupt.

## Review findings and resolutions

Codex (read-only) review of `ac16d0da05`:

| #     | Finding                                                                                                              | Verified                                                                                                                                                 | Resolution                                                                                                                                      |
| ----- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 #1 | The tripwire cannot establish quiescence: a start registered before the last check can be in transit while Git runs. | Yes: `executions.set` precedes the forked `started` hook (`run-coordinator.ts` L82-95); heartbeat is a separate `Stream.tick` merge (`event.ts` L18-25). | **Fixed.** The statement is the guarantee; probe and fence are best-effort detection. "Proof" wording removed.                                  |
| #2    | A true statement must exclude schedules and plugins.                                                                 | Yes: both start work unannounced.                                                                                                                        | **Fixed.** Setting copy covers other clients, schedules and plugins that start work on their own; the doc lists what a true statement excludes. |
| P2 #3 | Schedule listing needs `sessionID`; disabled schedules answer Forbidden, not 404.                                    | Yes: `schedule.ts` L37-41; `handlers/schedule.ts` L14-17, L74-75.                                                                                        | **Fixed.** Per-session listing; disabled-Forbidden is none; any other error refuses. No missing route counts as safe.                           |
| P2 #4 | The reverting thread's own OpenCode rewind would trip the fence.                                                     | Yes: `revert/stage` and `revert/commit` (`runtime.rs:4185-4199`) publish `session.revert.staged` (`revert.ts` L50-54) in the checkout.                   | **Fixed.** Exempted by session id and event type; fence test 14, guard test 16.                                                                 |
| P2 #5 | 10 s must be the total probe budget; #279's 15 s caps acquisition, not hold time.                                    | Yes.                                                                                                                                                     | **Fixed.** One 10 s budget per restore; refuse on exhaustion; probe test 9.                                                                     |
| Note  | A trip after the provider rewind uses the existing unrestored completion.                                            | Yes: `orchestration_effects.rs:2090-2163`.                                                                                                               | **Stated** in the hook, step 4.                                                                                                                 |

## Sources

- OpenCode 2: <https://github.com/anomalyco/opencode/tree/5a47777cc4c7511082e9ca5d4b430cea8113c4bb>
  (`packages/protocol`, `packages/core`, `packages/server`, `packages/schema`).
- OpenCode 1: <https://github.com/anomalyco/opencode/tree/v1.19.5/packages/opencode/src>.
- OpenCode server docs: <https://opencode.ai/docs/server> (lists `/session/status`, no state
  definitions).
- BiBCode adapter: `apps/server/src/provider/opencode/runtime.rs:1300-1392` (status
  reads), `:2134-2164` (`stop`), `:2871-2877` (self-started executions);
  `apps/server/src/provider/opencode/mod.rs:16-41` (protocol detection).
