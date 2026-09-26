# Environment supervisors start with the registry's connection intent

Status: **Approved by the user on 2026-09-26** — Option A: supervisors built with the stored intent, the follow-up connect dropped, and the clone's desiredSeen workaround removed in the same change. Land as its own change after the connection-liveness commit.

Date: 2026-09-26. Closes the residual that the
[clone reconnect record](./2026-09-24-clone-reconnect-design.md) left parked.
Line numbers are against `d87f854f` plus the uncommitted connection-liveness
tree. They may shift when that change lands.

Session evidence lives outside the repository (`$S` is the 2026-09-26
fan-out scratchpad root):

- the clone implementation report (`$S/clone/impl-report.md`, fix rounds 4
  and 5);
- the controller ledger (`$S/ledger.md`, search "desiredSeen").

## Problem and evidence

The registry owns connection intent, and each supervisor keeps a copy of it.
That copy starts out wrong.

- `EnvironmentRegistry` keeps intent in its private `desiredStates` map
  (`packages/client-runtime/src/connection/registry.ts:216-218`). The living
  doc names the registry as the owner (`docs/architecture/connection-runtime.md:386-393`).
- `createServiceScope` builds every supervisor with `initiallyDesired: false`
  (`registry.ts:344`). Only afterwards does it call `supervisor.connect`, and
  only when the stored intent is true (`registry.ts:353-355`).
- `connect` writes the supervisor's intent `Ref` and queues `ConnectRequested`
  (`supervisor.ts:782-788`). It never writes `state`. The run loop is the only
  writer of `state`. For an online environment, its first write happens when
  the driver reports `preparing` (`supervisor.ts:327-339`, `driver.ts:55`).
- Until that write, `state` holds its construction value: `availableState`,
  with `desired: false` (`supervisor.ts:287-299`). Two library details keep
  that value visible:
  - `Effect.forkScoped` schedules the loop instead of running it inline
    (`.repos/effect-smol/packages/effect/src/internal/effect.ts:5219-5239`).
  - `SubscriptionRef.changes` replays the latest value to every new
    subscriber, and `set` always publishes
    (`.repos/effect-smol/packages/effect/src/SubscriptionRef.ts:111-119, 160, 250-253`).

So every supervisor the registry creates first reports "not wanted,
available", even when the registry is about to dial. This happens in three
places:

- at startup (`start`, `registry.ts:474-489`);
- on a cold acquisition (`registry.ts:405-406`);
- on every replacement. `installEntryLocked` closes the old scope, publishes
  the new installation token, then creates the new supervisor
  (`registry.ts:383-386`).

Followers re-bind on that token and wait on the lease lock. They then read the
replayed value (`registry.ts:443-472`), so they can observe it.

**Evidence that the transient is observed, and what it costs:**

- **The break row.** Clone fix round 4 recorded break row
  `f6-plain-desired-rule`: under the plain rule ("an undesired state stops the
  wait"), a replacement made the clone stop falsely.
- **The workaround.** The clone therefore carries `desiredSeen` in
  `nextSession`. It ignores a replacement's `desired: false` until that
  replacement has published `desired: true`
  (`packages/client-runtime/src/state/vcsClone.ts:84-86, 101, 111-119`).
- **Its cost.** The ledger ruling "PARK desiredSeen residual" accepted it: a
  user disconnect that coincides with a replacement is never seen. The clone
  or cancel wait, which has no attempt limit and no timer
  (`connection-runtime.md:589`), lasts until one of three things happens: the
  environment reconnects, it is removed, or the dialog is closed. The living
  doc records this (`connection-runtime.md:592-594`). The race occurs in two
  orders:
  1. **Disconnect, then replacement.** The old supervisor is closed before its
     loop publishes `available`. The replacement is built undesired, so it only
     ever publishes `desired: false`.
  2. **Replacement, then disconnect.** The disconnect lands before the
     replacement's loop has run. The loop's first write is `available` again,
     and `desiredSeen` is still false.
- **Earlier reports.** This seam was flagged twice, in the 2026-08-29
  adversarial reviews: M-M
  (`docs/plans/remote-servers/2026-08-29-adversarial-review.md:261`), then
  M17, "`createServiceScope` still overrides its own intent"
  (`docs/plans/remote-servers/2026-08-29-remediation-adversarial-review.md:265`).
  Commit `867d257b` made `connect` conditional on the stored
  intent, but it kept the `false` constructor argument. (This is historical
  evidence, re-checked against the current code.)
- **Wrong projections.** For a few scheduler ticks, consumers that project
  the state show a disconnect that did not happen (table below). This
  duration was not measured. The driver reports `preparing` as its first
  action, so the flash is expected to last less than one frame.

### Consumers of `supervisor.state`

| Consumer                                                                                                                  | Today: first state of a desired supervisor                                                                         | With the fix                                             |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Status text and context card (`connection/presentation.ts:82-146`, fed by `state/connections.ts:66-78`)                   | "Available"                                                                                                        | "Connecting…"                                            |
| Remote Servers row (`ConnectTab.tsx:164-176`)                                                                             | Connect control, muted dot                                                                                         | Connecting, warning dot                                  |
| Git Manager and Pull Requests (`gitManagerAvailability.ts:90`, `pullRequestsAvailability.ts:36`)                          | "This environment is disconnected."                                                                                | "This environment is connecting."                        |
| Shell projection, rebuilt on each installation (`state/shell.ts:61-88, 311-313`)                                          | `unavailable` without a cache, which the sidebar ranks above loading (`Sidebar.logic.ts:44-52`): "Projects are unavailable" | `starting`: "Project data is still loading"              |
| Thread detail and activity (`state/threads.ts:184-195`, `state/activity.ts:553-588`)                                      | disconnected                                                                                                       | synchronizing or checking capability                     |
| Environment rail (`environmentRail.logic.ts:48-56`)                                                                       | disconnected dot                                                                                                   | unchanged: every phase other than connected shows this   |
| Query generations, the cut-off rule, remote updates (`state/runtime.ts:677-693, 738-744`; `state/remoteUpdates.ts:196-214`) | unaffected: they read only `connected`                                                                             | unaffected                                               |
| Pairing bearer proof (`connection/pairingAdd.ts:151-176`), storage adoption (`registry.ts:942-993`)                       | unaffected: they read only `connected` or `blocked`                                                                | unaffected                                               |
| Clone and cancel waits (`vcsClone.ts:91-139`)                                                                             | ignored through `desiredSeen`                                                                                      | the plain rule (below)                                   |

The uncommitted liveness diff to the supervisor never reads or builds the
initial state. That diff covers retry jitter, the idle ladder with
`SelectionChanged`, and `labelDisconnectFailure`. The idle ladder starts only
after failures. The first `connecting` state has `attempt: 1` and no failure,
so no "Reconnecting…" suffix appears.

**Tests.** `awaitConnectionState` returns the current state when it already
matches (`registry.test.ts:630-643`). A wait for `desired === false`
(`registry.test.ts:1387-1393, 1872-1877`) could therefore be satisfied by the
transient. Those tests disconnect first, so they remain valid; after the fix,
only a real disconnect satisfies them.

## Goals and non-goals

**Goals:**

- A supervisor publishes the registry's stored intent from its first state
  onwards. The run loop remains the only writer of `state`.
- A disconnect is observable on the current supervisor even when it coincides
  with a replacement, so the clone and cancel waits stop.
- Dialing is unchanged:
  - a desired environment makes the same attempts as today;
  - an undesired environment never dials, including on a passive state lookup.

**Non-goals:**

- The atom placeholder shown before the first emission
  (`initialValue: AVAILABLE_CONNECTION_STATE`, `state/connections.ts:76`). It
  still shows "Available" until the stream emits.
- A public intent API on the registry.
- Supervisor retirement semantics.
- Any change to the wire protocol, schemas, persisted shape, server, or
  desktop host.

## Alternatives

### A. Build each supervisor with the stored intent (recommended)

`createServiceScope` passes `initiallyDesired: desired` and drops the
follow-up `connect`. The supervisor already supports this path: most tests in
`supervisor.test.ts` construct it with `initiallyDesired: true`.

`nextSession` switches to the plain rule: `blocked` or `!desired` on the
current supervisor means `Stopped`. `desiredSeen` and its doc comment are
removed.

- **Performance.** One fewer queued signal per supervisor. There is also no
  redundant loop pass while offline: today, the queued `ConnectRequested`
  wakes an offline loop once more, and the loop publishes `offline` twice. No
  new allocation or fiber.
- **Reliability.** There is one writer, and the first state comes from the
  same intent `Ref` that the loop reads. Both orders of the residual stop the
  wait. The plain rule cannot stop falsely:
  - a supervisor publishes `desired: false` only while its intent is false,
    and that intent now starts equal to the registry's;
  - the only lag left is the loop's reaction to an explicit Connect or
    Disconnect. Today's rule already treats that lag the same way for the
    current supervisor.
- **Compatibility.** The change is internal to the client runtime and
  nothing crosses the wire, so old and new servers are unaffected. No
  persisted shape changes.
- **Security.** No effect.
- **Complexity.** Lower than today. It removes a workaround that every
  future state observer would otherwise have to copy.

**Both parts are needed:**

- The root fix alone leaves order 1 hanging: the replacement never publishes
  `desired: true`, so `desiredSeen` stays false.
- The plain rule alone stops falsely whenever a follower reads a desired
  replacement's construction state (break row `f6-plain-desired-rule`).

### B. Publish state on `connect` and `disconnect`

Keep `initiallyDesired: false`, but make `connect` and `disconnect` write
`connectingState` and `availableState` themselves. This removes the
transient, but it adds a second writer of `state` that races the loop:

- a `connect` during backoff would publish "connecting" while the loop is
  still waiting;
- a finishing attempt's stale `connected` could overwrite a `disconnect`.

Fencing these races needs a generation check on every write. Compatibility
and security are the same as A (internal to the client runtime); complexity
and reliability risk are higher. **Rejected.**

### C. Observe the registry's intent instead

Expose `desiredStates`, for example as a per-environment intent stream, and
have the clone watch it instead of `state.desired`. The supervisor stays
untouched. The drawbacks:

- It creates a second observable "desired" that disagrees with
  `state.desired` during every installation.
- It leaves the false "disconnected" projections in place.
- Each consumer must choose which source to trust: a duplicate source of
  truth.
- The clone rounds already declined a public intent API (ledger: "Registry
  desiredStates is private").
- Compatibility and security are the same as A; complexity is higher (a new
  API and a second intent source), and performance is similar.

Keeping today's workaround is the zero-cost variant of this option, and it
leaves the residual in place.

Starting the loop with `startImmediately` is not an option: the loop would
read `desired: false` before `connect` runs.

## Recommendation

Option A, as its own change after the connection-liveness change is
committed:

1. In `registry.ts` `createServiceScope`, pass `initiallyDesired: desired`,
   and delete `if (desired) yield* supervisor.connect`.
2. In `vcsClone.ts` `nextSession`, apply the plain rule and delete
   `desiredSeen`. Rewrite the doc comment so that a replacement is treated
   like any other supervisor.
3. Optional tidiness in `supervisor.ts`: build the initial offline state with
   `attempt: 1`, matching the loop's first pass (`supervisor.ts:297` against
   `:677`). This avoids two `offline` emissions with different attempts.
   Nothing renders `attempt` for the offline phase.

**State shape.** The first state becomes `connectingState(intent, 0, 1, null)`
(generation 0, attempt 1), and the attempt's own states carry generation 1.
Every consumer compares generations only in the `connected` phase. The shell's
`changesWith` still emits a single empty switch, as today; its trigger becomes
the generation moving from 0 to 1 instead of the phase changing.

**What users see:**

- At startup and on a replacement, the supervisor's first state reads
  "Connecting…". The atom placeholder is unchanged.
- A disconnected environment still starts at "Available".
- A disconnect during a replacement ends the clone wait at once, with the
  existing copy "Can't reconnect to <environment>." (`VcsCloneStoppedError`,
  reason `environment-unavailable`).

No copy is added.

## Affected packages and files

All changes are in `packages/client-runtime`:

- `src/connection/registry.ts` and `src/connection/registry.test.ts` (both
  liveness files);
- `src/state/vcsClone.ts` and `src/state/vcsClone.registry.test.ts`;
- optionally, `src/connection/supervisor.ts` and
  `src/connection/supervisor.test.ts` (both liveness files).

The one documentation change is `docs/architecture/connection-runtime.md`,
which is also a liveness file. Nothing changes in `apps/web`,
`packages/contracts`, `apps/server`, or `apps/desktop`.

## Validation

Write the tests first, and observe each red on today's code.

1. **Primary red→green (known to reproduce).** Switch `nextSession` to the
   plain rule first. On today's registry, the replacement tests in
   `vcsClone.registry.test.ts` stop falsely, as the break row recorded. Then
   apply the registry change: green.
2. **Registry first-state contract (deterministic).**
   - Add a hook to the scripted driver (`registry.test.ts:545-561`) that
     samples `registry.state(id)` before the driver reports `preparing`. The
     loop has written nothing before that point, so the sample is the
     construction state.
   - Assert `desired: true` and `connecting` after each of `register`,
     `reconcilePlatform` with a changed target, and `start`. Today these are
     red: `available` with `desired: false`.
   - For a disconnected environment, a replacement starts at `available` with
     `desired: false` and never dials. This extends the case already pinned at
     `registry.test.ts:1837-1892`.
   - An offline start is already covered at `supervisor.test.ts:603`.
3. **The clone residual** (`vcsClone.registry.test.ts`, with
   `hangConnect(MOVED)`). Run it in both orders:
   - (a) `registry.disconnect`, then `reconcilePlatform([MOVED])`, issued
     back to back in one fiber;
   - (b) the same two calls in the reverse order.

   Both the clone and a pending cancel must end with `VcsCloneStoppedError`
   "Can't reconnect to Remote (moved).". Today they hit the 10-second test
   timeout, which is also how the F6 tests failed before fix round 4. These
   tests depend on the interleaving, so keep one only if its red is observed.
   Tests 1 and 2 are the guaranteed evidence.
4. **Break rows.**
   - Keep `desiredSeen` with the registry fix: 3(a) hangs.
   - Revert the registry but keep the plain rule: the false stop in test 1
     returns.
5. **Existing coverage stays green:**
   - the F6 and N1 real-registry tests;
   - `supervisor.test.ts:576` and `:588` (the default stays `false`);
   - `registry.test.ts` and `activity.test.ts`.
6. **Gates:**
   - `vp test run packages/client-runtime/src/connection packages/client-runtime/src/state`;
   - the web tests for Git Manager and Pull Requests availability,
     `ConnectTab`, and the sidebar (no change expected);
   - `vp check` and `vp run typecheck`.

   No Rust changes.

**Live checks.** The transient lasts a few scheduler ticks, so a screenshot
cannot prove it is gone; tests 1 and 2 are the proof. The residual itself is
hard to reach from the UI while the clone dialog is open, because the modal
covers the Disconnect controls. The live pass is therefore a regression sweep
on an isolated dev server
(`BIBCODE_PORT_OFFSET=<n> BIBCODE_HOME=$S/<id>/home vp run dev`), with a
second `bibcode serve` as a remote environment. In light and dark themes:

1. Start with one desired remote and one disconnected remote. The
   disconnected one must stay "Available" and never dial.
2. Use Connect, Disconnect, and Rename in **Settings → Remote Servers**.
3. Run clone steps 5-8 of `docs/testing/cross-platform-validation.md`.

## Documentation to update

- **`docs/architecture/connection-runtime.md`.**
  - In the intent paragraph (386-393), add that the registry creates a
    supervisor with the stored intent, so its first published state already
    carries that intent.
  - Delete the "One exception" sentence (592-594).
- **`docs/testing/`.** No procedure changes. Record in the implementation
  report that the runbooks were "reviewed and remain accurate".
- **The clone reconnect record.** It keeps its residual as history; do not
  edit it.

## Risks

- **Sequencing.** These files are part of the uncommitted liveness change
  (`$S/liveness/changed-files.txt`) and are still being edited:
  - `registry.ts` and `registry.test.ts`;
  - `supervisor.ts` and `supervisor.test.ts`;
  - `connection-runtime.md`.

  Implement only after that change is committed, then re-check the
  citations.
- **The invariant.** The plain rule relies on this invariant: the published
  `desired` follows the registry. Two future paths could break it and make
  the clone stop falsely:
  - a supervisor constructed outside the registry, because the `false`
    default remains;
  - a direct call to `supervisor.disconnect`.

  Test 2 guards the registry path. Making `initiallyDesired` required on
  `make` would guard new constructors.
- **Stricter tests.** Tests that wait on `desired === false` become stricter.
  An unexpected timeout there points to a real intent bug, not a flake.
- **Traces.** Traces no longer show an `EnvironmentSupervisor.connect` span
  when the registry creates a supervisor.

## Open questions for the user

1. Approve Option A, including removing `desiredSeen` in the same change?
2. Drop the redundant `connect` (recommended), or keep it as a harmless
   belt-and-braces step? `supervisor.test.ts:588` shows that an extra
   `ConnectRequested` cannot cancel the first attempt.
3. Include the optional hardening: the initial offline state with
   `attempt: 1`, and `initiallyDesired` required on `make`?
4. Confirm the sequencing: land this as its own change after the liveness
   commit.
5. Confirm that the atom's pre-emission "Available" placeholder stays out of
   scope. It could be a separate follow-up if wanted.
