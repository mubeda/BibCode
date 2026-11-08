# Checkpoints: Restore Files Beside a Quiet External OpenCode Server

Status: Proposed — awaiting Codex + advisor review. Issue #326, a follow-up to #279
([`2026-11-07-shared-checkout-restore-guard-design.md`](./2026-11-07-shared-checkout-restore-guard-design.md),
approved, on branch `worktree-agent-acfdd3a967c39b8d0` at the time of writing). BiBCode
line references are to `e222d340ff`. OpenCode references are to the source read for this
note: OpenCode 2 at `anomalyco/opencode` `dev` commit `5a47777cc4c7` (package version 2.2.5,
read 2026-11-07; latest release v2.2.6), and OpenCode 1 at tag `v1.19.5` (commit
`810c0eba1a73`, the newest 1.x tag). Nothing was run against a live OpenCode server for
this note. No product code is written until the maintainer approves.

## Outcome

#279 refuses every host file restore in a checkout while another chat there (a "sibling")
uses an OpenCode instance with `serverUrl` set (an "unmanaged sibling"). BiBCode does not
own that server, and suspending BiBCode's session only stops observing it. The issue asks:
if OpenCode's API can prove the sibling's session idle and unable to start work by itself
for the restore's duration, use that proof and restore; otherwise keep refusing.

**Finding: OpenCode's API cannot prove that.** Neither version has a lock, pause or
prompt-admission control. Any other client of the server (TUI, web UI, another app) and
any plugin can start work at any moment, with no prior signal. A client can only show
"nothing is running or pending right now" and watch for a start afterwards.

**Decision (proposed):** keep #279's refusal as the default. Lift it only for an
instance where the maintainer states, in a new per-instance setting, that BiBCode is the server's
only client. For such an instance on OpenCode 2, a probe shows the sibling's session tree
idle with nothing pending, keeps an event-stream tripwire open through the restore, and
checks it again before each irreversible step. Anything it cannot read refuses. OpenCode 1
keeps refusing. Whether a user statement counts as "proof" is the maintainer's call (question 1);
if he says no, the issue closes with no product change beyond the refusal copy.

## What OpenCode's API offers (verified in source)

| Need                       | OpenCode 2 (`/api/*`)                                                                                                                                                                                                                                                                                                                                                                       | OpenCode 1                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is it running now          | `GET /api/session/active`: a flat map of session id to `{type:"running"}` for executions **owned by this server process** (`packages/protocol/src/groups/session.ts` L41-43, L220-230). Retry backoff, compaction and permission or question waits stay inside the execution, so they show as running (`core/src/session/runner/retry.ts` L57-77, `runner/llm.ts` L245-252, `form.ts` L152-157). | `GET /session/status`: `{id: busy \| retry}`, idle ids omitted, so an unknown id also looks idle (`opencode/src/session/status.ts` L28-47). The map is **per directory**: it uses `?directory=`, then `x-opencode-directory`, then the server's cwd. A wrong directory returns `{}` (`middleware/workspace-routing.ts` L86-88, L175-183). |
| Is work pending            | Unconsumed background jobs, children included: `GET /api/experimental/job?sessionID=&descendants=true`. A finished child's row stays until its result is admitted to the parent (`protocol/src/groups/job.ts` L12-44, `core/src/session/subagent-completion.ts` L37-45). Parked input: `GET /api/session/{id}/inbox` (`session.ts` L540-552). Pending forms: `GET /api/session/{id}/form`. Both job and log routes are marked experimental. | None found. Background subagents (behind `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`) re-prompt the parent after the child ends, with no listing route.                                                                                                                                                                            |
| Durable hint               | `GET /api/session/{id}`: `time.busy` after `time.idle` means an execution started without a terminal event, including one left by a crash (`schema/src/session.ts` L44-49, `core/src/session/projector.ts` L840-861).                                                                                                                                                                         | None.                                                                                                                                                                                                                                                                                                                              |
| Stop                       | `POST /api/session/{id}/interrupt` acknowledges before cleanup, one session only, and does not block a later prompt (`session.ts` L672-690, `execution.ts` L151-168).                                                                                                                                                                                                                            | `POST /session/{id}/abort` always returns `true`; it does not block a later prompt (`handlers/session.ts` L232-235).                                                                                                                                                                                                              |
| Lock, pause, admission     | None. The only pause is per schedule, `POST /api/experimental/schedule/{id}/pause` (`protocol/src/groups/schedule.ts` L47-52). A prompt is admitted whenever the session exists (`session.ts` L337-357).                                                                                                                                                                                        | None. The per-session runner lock is internal; only revert, unrevert and message delete check it.                                                                                                                                                                                                                                  |
| Event stream               | `GET /api/event`, global across directories, `server.connected` first, heartbeat every 15 s, frames carry no `id:`, no `Last-Event-ID`, no replay, and a 4096-frame queue that **fails** the stream on overflow (`server/src/handlers/event.ts` L10-37, `server/src/event-feed.ts` L8, L29-31, L66-78). Start and end: `session.execution.started` / `succeeded` / `failed` / `interrupted` (`schema/src/session-event.ts` L244-264). | `GET /event?directory=` (one directory) and `/global/event`, `server.connected` first, heartbeat every 10 s, no SSE `id`, no replay. `session.status` and `session.idle`; `idle` is published before the runner finishes unwinding (`session/status.ts` L38-44, `processor.ts` L626-638).                                                       |
| Server identity            | `GET /api/info` carries the process `pid` (`protocol/src/groups/server.ts` L5-8, L45-50).                                                                                                                                                                                                                                                                                                        | None beyond `server.connected` on reconnect.                                                                                                                                                                                                                                                                                       |

BiBCode already reads the first row: `session_still_working` (`provider/opencode/runtime.rs:1372-1392`)
asks `/api/session/active` or `/session/status`, and treats a server without the route as
idle (`:1340`). That default is right for delivery deduplication and wrong for a restore.

### What starts work with no prompt from BiBCode

| Starter                                                     | Visible beforehand?                                                                                                     | Source                                                                         |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Prompt from another client (TUI, web, app, ACP)             | **No.**                                                                                                                 | v2 `session.ts` L155-191; v1 `prompt.ts` L1052-1070                             |
| Plugin event handler or plugin RPC admitting input          | **No**, and installed plugins cannot be enumerated for this purpose.                                                    | v2 `core/src/plugin/host.ts` L592, `plugin/command.ts` L70                      |
| Background subagent finishing                               | v2: child in `/active`, then a job row until delivered. v1: child busy, then a gap before the parent is prompted.       | v2 `subagent-job.ts` L45-62, `subagent-completion.ts` L21-45; v1 `tool/task.ts` |
| Background shell or image job finishing (also writes files) | v2: job row `kind: shell`, which outlives the session's execution.                                                      | v2 `tool/plugin/shell.ts` L144-176, `session/background.ts` L30-40              |
| Retry, auto-compaction, `/goal` continuation                | Inside a running execution, so visible as running.                                                                      | v2 `retry.ts` L57-77, `llm.ts` L175-186; v1 `retry.ts`, `prompt.ts` L1146-1170  |
| Scheduled prompt (v2.2, `experimental.schedules`)           | Rows in `GET /api/experimental/schedule` with `next_due_at`.                                                            | v2 `core/src/schedule.ts` L272, L431-452                                        |
| Server restart resuming a claimed execution                 | `time.busy` after `time.idle`; the event stream drops and the `pid` changes.                                            | v2 `session/execution/restart.ts` L36-64, L221-258                              |
| Executions in another OpenCode process sharing the database | **No.** `/api/session/active` covers this process only.                                                                 | v2 route description, `schedule.ts` L76-79                                     |

Non-execution writers can also change files while every session is idle: a user shell
(`POST /api/session/{id}/shell`, outside the execution coordinator, `session.ts` L192-235),
terminals (`/api/shell`, `/api/pty`, persistent PTYs; v1 `/pty`), and the file API
(`POST /api/experimental/fs/write`). All are started by a client.

Three rows say **No**. Those starters are only excluded if nobody else uses the server,
which BiBCode cannot check. That is why the proof needs a statement from the maintainer.

## Options

| Option                                                                                         | For                                                                                                       | Against                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(A)** Keep #279's refusal. Improve the copy to name the fix (clear Server URL so BiBCode starts its own server). | No code, no risk. Correct by the evidence above.                                                          | The issue's case stays blocked. The maintainer's workflow with a long-running external server keeps only "Rewind conversation only".                                                     |
| **(B)** Probe automatically for every unmanaged sibling.                                         | No setting.                                                                                               | Not a proof: another client's prompt, a plugin or another process can start work unseen. A restore would overwrite that work. Breaks the issue's "otherwise keep refusing".      |
| **(C) proposed:** (B) only for an instance marked "Only BiBCode uses this server", OpenCode 2 only. | Every remaining starter is visible to the probe or trips the event fence. The default stays safe.         | Rests on a statement BiBCode cannot verify. One setting field (a contracts schema change). Uses experimental OpenCode 2 routes, so a server without them refuses.               |
| **(D)** Interrupt the sibling's session before restoring.                                       | Stops a running turn.                                                                                     | Interrupt is not a lock; work can start again at once. Destroys the sibling's work instead of protecting it.                                                                     |
| **(E)** Ask in the revert dialog each time ("I'm sure nothing else uses this server").           | No setting.                                                                                               | Asks a question the person cannot answer at revert time (UI.md: match the mental model, safe defaults). A habit-forming checkbox in front of an overwrite.                       |
| **(F)** Stage a revert on the sibling's OpenCode session to block background wake-ups.           | OpenCode 2 skips synthetic wakes while a revert is staged (`session.ts` L323).                            | A user prompt still wakes and commits the staged revert (`session.ts` L173). It mutates the sibling's conversation. Incidental behaviour, not a contract.                       |

Option (C) costs one setting and one probe module; (A) remains its fallback in every
failure path.

## Decision: option (C)

### The statement

A new boolean in `OpenCodeSettings` (`packages/contracts/src/settings.ts:490-530`),
`exclusiveServer`, default `false`, shown after `serverPassword`:

- Title: "Only BiBCode uses this server"
- Description: "Turn on only if no OpenCode TUI, web page, other app, plugin or schedule
  sends work to this server. Lets BiBCode restore files while another chat uses it."

It has no effect when `serverUrl` is empty: a BiBCode-started server is already managed,
and #279 suspends its siblings. The provider instance resolution that reads `serverUrl`
(`production/provider_runtime.rs:6221-6222`, `:6559-6562`) carries the flag next to it.

### The probe (OpenCode 2 only)

Run for each unmanaged sibling whose instance has `exclusiveServer`, after #279 has
suspended BiBCode's session for it. It is a short-lived client separate from any runtime,
with the instance's URL and password, each request bounded by the existing
`DELIVERY_LOOKUP_TIMEOUT`, and the whole probe by 10 s. Steps, in this order:

1. `GET /api/info`. Not OpenCode 2 → refuse. Keep the `pid`.
2. **Open the fence:** `GET /api/event`, and wait for `server.connected`. Everything that
   starts after this frame reaches the fence.
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
7. `GET /api/experimental/schedule`: any schedule that is not paused and targets a tree
   session → refuse. A 404 here passes (schedules are off or absent).
8. `GET /api/shell` and `GET /api/pty`: their response shape was not verified for this
   note. If entries carry a directory, refuse on one inside the checkout; if they do not,
   refuse on any entry. A 404 passes; terminals other clients open are covered by the
   statement.

A 404, non-JSON answer, timeout or unexpected shape at steps 1 to 6 refuses: "BiBCode
can't read whether Panel's OpenCode server is idle." The probe never sends a prompt,
interrupt or revert to the sibling's session.

The probe returns a `QuietFence`: the open stream, the tree ids, the checkout path and the
`pid`. The fence **trips** on any of:

- `session.execution.started`, `session.inbox.enqueued`, `session.synthetic`,
  `session.shell.started` or `session.revert.staged` for a tree id;
- the same events for any other session whose `location` is inside the checkout, or that
  carries no `location`;
- a second `server.connected`, the stream ending or failing (overflow fails it), or no
  bytes for 20 s. OpenCode 2's heartbeat is an SSE comment (`: heartbeat`, every 15 s),
  which the adapter's decoder (`provider/opencode/sse.rs`) yields as no data, so the fence
  counts any chunk read from the body as liveness, not only decoded frames.

`QuietFence::check()` returns `Err` once tripped, and also re-reads `GET /api/info` and
trips on a changed `pid`. Dropping the fence closes the stream.

### Races, and how each is closed

| Race                                                                                                  | Closed by                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A start between the status reads and the restore.                                                     | The fence opens before the reads (step 2). OpenCode 2 lists an execution in `/active` before `execution.started` is published (`run-coordinator.ts` L82-91), so a start is in the read or on the stream. |
| A child finished but its result is not yet admitted to the parent.                                     | Step 5: the job row stays until the result is admitted.                                                                                                                           |
| A background shell keeps writing after its session went idle.                                          | Step 5 (`kind: shell` row) and step 8.                                                                                                                                            |
| Events missed while disconnected (no replay).                                                          | A disconnect, a second `server.connected` or a silent stream trips the fence.                                                                                                     |
| The server restarts and resumes a claimed execution.                                                   | Step 6 (`time.busy` after `time.idle`), and a restart drops the stream and changes the `pid`.                                                                                     |
| A start lands after the provider rewind (irreversible) but before `restore_checkpoint`.                | A second check immediately before `restore_checkpoint` (below). The Git restore is what would overwrite sibling work, so it is skipped and the revert ends as a failure after rollback. |
| A start lands during `restore_checkpoint` itself (milliseconds of `restore`, `clean -fd`, `reset`).    | Not preventable. Under the statement there is no known starter left; a trip here is reported after the restore so the person can check that chat's files.                          |
| Another client's prompt, a plugin, another process on the same database.                               | **Only the statement.** The fence catches a violation that starts after step 2, but only reports it.                                                                              |
| OpenCode 2 location-bound routes answer for the wrong directory.                                      | The probe sends the adapter's location; a test pins which routes need it (step 3).                                                                                                 |
| OpenCode 1: wrong-directory `{}`, `idle` before the runner ends, `prompt_async` 204 before `busy`, no job listing. | Not attempted: OpenCode 1 keeps refusing.                                                                                                                                         |

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
   (`orchestration_effects.rs:2023-2165`): a tripped fence skips the Git restore. The
   outcome is #279's existing "failure after rollback" path (conversation rewound, files
   not restored, the person reverts again) with its own message.
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
no thread or checkout gate, so #279's lock order is unchanged. It adds up to 10 s per
statement-marked sibling to step 5, inside the checkout gate; deliveries waiting on the
gate wait that much longer.

### Copy (checked against `UI.md`)

| Case                                    | Message                                                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unmanaged, no statement                 | #279's message, unchanged: "Panel, OpenCode runs on an OpenCode server BiBCode doesn't manage, so BiBCode can't make sure it has stopped working in this checkout. Rewind only the conversation instead." |
| OpenCode 1 with the statement           | "Panel's OpenCode 1 server can't report whether it's idle. Rewind only the conversation instead."                                                              |
| Probe sees work                         | "Panel's OpenCode server is still working in this checkout. Try the revert again when it finishes."                                                            |
| Probe cannot read                       | "BiBCode can't read whether Panel's OpenCode server is idle. Rewind only the conversation instead."                                                           |
| Trip before `restore_checkpoint`        | "The conversation was rewound, but files weren't restored: Panel's OpenCode server started working. Revert again when it finishes."                            |
| Trip after `restore_checkpoint`         | "Files were restored, but Panel's OpenCode server started working during the restore. Check Panel's changes."                                                 |

The settings description is the only place that names the statement. Refusals do not
suggest turning it on, so the person is not nudged into a statement made to get past a
dialog (question 3).

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
6. Active schedule targeting the root → refused; schedule route 404 → passes.
7. Terminal inside the checkout → refused; outside it → passes.
8. Job route 404 (an older 2.x) → refused, "can't read".
9. A route that never answers → refused within the probe bound.
10. OpenCode 1 server (`/global/health` JSON, `/api/info` absent) → refused before any
    session read.
11. Fence: `session.execution.started` for a tree id → trips; for a session located in
    another directory → does not trip; with no location → trips.
12. Fence: second `server.connected`, stream closed, stream silent for 20 s, `pid` changed
    at `check()` → each trips.
13. Dropping the fence closes the connection (the server sees it end).

Guard tests (on top of #279's tests, same module as its 12c):

14. `a_declared_exclusive_idle_opencode_sibling_allows_the_restore`: files restored.
15. #279's 12c still passes unchanged for an instance without the statement.
16. `a_sibling_execution_after_planning_refuses_before_the_rewind`: the event arrives
    between step 5 and step 7 → refused, no provider rewind, no file changed.
17. `a_sibling_execution_after_the_rewind_skips_the_file_restore`: the event arrives after
    `rollback_provider` → conversation rewound, files untouched, the trip message.
18. `a_refused_restore_closes_every_quiet_fence`: the scripted server sees each stream end
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

- **A false statement overwrites work.** If another client uses a server marked exclusive,
  a prompt sent before step 2 and not yet visible (OpenCode 2 lists a woken execution
  synchronously, so this window is small) or one sent during `restore_checkpoint` can lose
  that turn's file changes. The fence reports what it sees.
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

## Questions only the maintainer can answer

1. Does "the maintainer states BiBCode is the only client" count as the issue's proof? If not,
   choose (A): the issue closes with the refusal copy only.
2. Is OpenCode 2 only acceptable, or does an OpenCode 1 external server matter to you?
   (Supporting it needs a per-directory status read and has no pending-work listing.)
3. Should a refusal mention the setting? The design says no, to avoid nudging a statement
   made just to get past the dialog.
4. Is up to 10 s of probe time per marked sibling, inside the checkout gate, acceptable?

## Sources

- OpenCode 2: <https://github.com/anomalyco/opencode/tree/5a47777cc4c7511082e9ca5d4b430cea8113c4bb>
  (`packages/protocol`, `packages/core`, `packages/server`, `packages/schema`).
- OpenCode 1: <https://github.com/anomalyco/opencode/tree/v1.19.5/packages/opencode/src>.
- OpenCode server docs: <https://opencode.ai/docs/server> (lists `/session/status`, no state
  definitions).
- BiBCode adapter: `apps/server/src/provider/opencode/runtime.rs:1300-1392` (status
  reads), `:2134-2164` (`stop`), `:2871-2877` (self-started executions);
  `apps/server/src/provider/opencode/mod.rs:16-41` (protocol detection).
