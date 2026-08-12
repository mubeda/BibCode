# Targeted Activity Subtree Cancellation Design

**Date:** 2026-08-11

**Status:** Approved; pending implementation

## Summary

Add a **Stop** control to active, cancellable actors in the Activity panel's
Subagents roster. The control cancels only the selected actor and every actor
or attributable background work item in its descendant subtree. It never
cancels the selected actor's parent, siblings, or the root chat as a fallback.

Cancellation uses provider-native controls behind the server boundary:

- Codex interrupts the active turn for each selected descendant thread.
- Claude stops each background task whose `task_id` is authoritatively
  correlated with a displayed subagent.

The server owns capability negotiation, native control handles, subtree
selection, cancellation fencing, bounded dispatch, retries, and authoritative
operation state. The web client sends only canonical Activity scope and actor
identities. It does not receive or reconstruct provider-native identifiers.

This feature changes Activity from a read-only observation surface into a
capability-gated observation and control surface. Implementation must therefore
update the corresponding living architecture and provider documents in the
same change.

## Problem

BiBCode already lets the user stop the root chat turn from the composer. That
operation is intentionally broad: it interrupts the provider turn that owns the
conversation. The Activity panel, however, is read-only. A user who sees one
subagent stuck, obsolete, or consuming resources cannot stop that actor without
also stopping useful parent and sibling work.

Calling the existing root-turn interrupt from an Activity row would make the UI
misleading and destructive. The row implies a narrow target, while the command
would cancel the entire parent workflow. A safe control requires exact
provider-native identity for the selected actor and all cancellable descendants.

The providers expose different identities:

- Codex App Server cancels an in-flight turn by `threadId` and `turnId`.
  Codex subagents are descendant threads, but BiBCode's current interrupt path
  always supplies the root provider thread.
- Claude's streaming control protocol can interrupt the root session and can
  stop one background task by `task_id`. Claude Activity actors currently use
  hook-supplied `agent_id` values, while task lifecycle messages carry separate
  `task_id` values.

The design must bridge those identities without guessing from names, timing,
prompt text, row order, or display labels.

## Research Conclusion

Both supported structured-chat providers have native cancellation mechanisms:

- [Codex App Server](https://developers.openai.com/codex/app-server) exposes
  `turn/interrupt({ threadId, turnId })` and completes the turn with
  `status: "interrupted"`. Descendant threads are independently addressable.
- [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/python) exposes
  `ClaudeSDKClient.stop_task(task_id)`. Task lifecycle messages classify
  background subagents as `local_agent` or `remote_agent`, and completion after
  cancellation is reported with `status: "stopped"`.

The mechanisms are sufficient for targeted cancellation only when BiBCode can
prove the mapping from a canonical Activity actor to the native control handle.
Capability must therefore be negotiated per actor, not assumed from the
provider name alone.

## Goals

- Put a discoverable Stop button on every active Activity actor for which exact
  targeted cancellation is available.
- Cancel the selected actor's entire observable descendant subtree.
- Preserve the parent, siblings, root chat turn, and unrelated provider work.
- Catch descendants that start while cancellation is already in progress.
- Cancel attributable background work inside the selected subtree when the
  provider exposes a scoped native control handle.
- Keep provider-native thread, turn, task, process, and agent identifiers on the
  server.
- Make cancellation idempotent, bounded, generation-fenced, reconnect-safe, and
  honest about partial failure.
- Use provider events as the source of truth for terminal actor lifecycle.
- Preserve current Activity performance bounds under large subagent trees.

## Non-goals

- A Stop All button.
- Falling back to the root composer interrupt.
- Cancelling parents, siblings, independent sessions, or unrelated terminals.
- Steering, resuming, rerunning the actor's original task, messaging,
  archiving, deleting, or closing an actor after cancellation. Retrying failed
  cancellation delivery for the same residual subtree remains in scope.
- Cancelling foreground Claude subagents that do not expose an independently
  addressable background task.
- Guessing Claude `agent_id` to `task_id` correlation.
- Controlling activity observed from provider terminals in the first release.
- Treating arbitrary operating-system descendants as attributable provider
  work when the provider exposes no scoped handle.
- Persisting provider-native control handles in SQLite.
- Replacing the existing root-turn Stop action in the chat composer.

## Approved Decisions

| Decision | Approved choice |
| --- | --- |
| User target | One selected Activity actor |
| Cancellation boundary | Selected actor plus its entire descendant subtree |
| Parent and siblings | Never cancelled |
| Missing exact target | No broad fallback; action is unavailable or fails closed |
| First-release scope | Structured-chat `thread` scopes only |
| Provider controls | Codex `turn/interrupt`; Claude `stop_task` |
| Native identities | Private server-side control registry |
| UI confirmation | Immediate action; no confirmation dialog |
| Pending state | Server-authoritative `Stopping` control state |
| Completion authority | Provider lifecycle events |
| Duplicate action | Join the existing cancellation operation |
| Partial failure | Report residual actors/work and offer scoped retry |
| Terminal Activity | Remains read-only |

## Rejected Alternatives

### Reuse the root-turn interrupt

This is the smallest code change, but it violates the selected-row boundary by
cancelling the parent and siblings. A warning dialog would describe the damage
but would not make the operation targeted. This option is rejected.

### Ask the parent model to stop a named child

A cooperative prompt is nondeterministic, can be delayed behind the active
turn, depends on model behavior, and may target the wrong child when names are
duplicated or stale. It cannot provide a reliable cancellation guarantee. This
option is rejected.

### Expose native identifiers to the web client

Putting Codex thread/turn IDs or Claude task IDs in Activity records would make
the client provider-aware, leak control-plane identifiers across the wire, and
allow stale or cross-scope targeting bugs. The server already owns provider
sessions and is the correct policy boundary. This option is rejected.

## Terminology and Invariants

### Cancellation subtree

For a selected actor `A`, the cancellation subtree contains `A` and every actor
reachable through canonical `parentActorId` edges within the same Activity
`scopeId`. An attributable work item is included when its `ownerActorId` is in
that actor set and the provider supplies an exact scoped cancellation handle.

The server computes the subtree from an authoritative in-memory Activity scope,
not from client-provided descendant IDs. Cycles, cross-scope references, and
missing parents remain invalid under the existing Activity invariants.

### Cancellation fence

A cancellation fence is an ephemeral server-side marker on the selected actor.
While it is active, a newly observed actor whose ancestor chain reaches the
selected actor joins the cancellation operation before it can become
independently actionable. This closes the race in which the selected actor
spawns another child while cancellation requests are being dispatched.

### Exact control handle

An exact control handle contains the provider identity required to target one
actor or work item and no broader scope:

- Codex: native descendant `threadId` plus its active `turnId`.
- Claude: native background `task_id` proven to belong to one `agent_id`.
- Attributable background work: the provider's task/process handle plus its
  proven owner.

The handle is bound to one provider runtime instance, Activity `scopeId`, and
observation generation. It is never inferred from the canonical record ID.

## User Experience

### Roster row

Every active actor whose server control state is `available` shows a persistent
Stop button at the trailing edge of its Subagents roster row. The main row area
continues to open actor detail. The row and Stop control are sibling interactive
elements; implementation must not nest one button inside another.

The Stop control:

- uses the same stop-square visual language as the chat composer;
- is keyboard reachable and has a visible focus ring;
- has an accessible label such as `Stop Lovelace and 2 child agents`;
- uses a tooltip with the same subtree impact;
- does not require a confirmation dialog; and
- stops click propagation so it does not open actor detail.

Done actors never show the ordinary Stop button. Unsupported active actors do
not show a disabled mystery icon. When a useful explanation exists, actor
detail may state that this provider did not expose an exact cancellation
target.

### Pending cancellation

After the server accepts cancellation, the selected actor and all currently
known active descendants display `Stopping`. Their Stop buttons are disabled.
An actor discovered later under the cancellation fence enters `Stopping`
without first offering an active Stop button.

`Stopping` is control-plane state, not a terminal provider lifecycle. The
existing provider lifecycle remains `starting`, `running`, `waiting`, or
`unknown` until authoritative provider events report `interrupted`,
`cancelled`, `completed`, or `failed`.

### Completion and errors

Provider-confirmed terminal actors move to Done using the existing Activity
lifecycle labels. Cancellation operation errors appear as a scoped Activity
notification and do not replace the last valid provider status.

If part of the subtree remains active after bounded cancellation attempts, the
panel shows the remaining count and a **Retry remaining** action. That action
targets only the residual members of the original subtree. Independently
active descendant rows also regain their own Stop buttons when safe.

An actor that completes naturally while the click is racing is treated as
already finished. The UI refreshes without presenting a failure.

## Activity Protocol and Contracts

### Protocol version

The control metadata and mutation are a coherent Activity protocol change.
Increment `activityProtocolVersion` and `ActivitySnapshot.protocolVersion` from
`1` to `2` rather than adding a partially understood optional field to protocol
v1. Existing exact-version negotiation continues to fail closed between
mismatched clients and servers.

### Capability and actor control state

Add a scope-level capability indicating that targeted actor cancellation can be
represented. The scope capability does not make every actor cancellable.

Each actor may have a canonical control-overlay record, joined to the actor by
`actorId`, with these states:

- `unsupported`: no exact handle exists for this actor in the current runtime;
- `available`: an exact handle exists and no covering cancellation is active;
- `requested`: this actor is covered by an active cancellation fence.

The control record also carries a non-negative `controlRevision`. The server
increments it whenever the actor's native handle, provider runtime instance, or
control eligibility changes. The revision is an Activity concurrency fence, not
a provider identifier or bearer credential. It also carries the current active
descendant count used for the Stop button's accessible subtree-impact label;
changing that count advances the overlay revision but does not by itself change
the actor's handle-fencing `controlRevision`.

The control record contains no native identifier. Control records and operation
summaries live in a bounded `ActivityControlSnapshot` with its own monotonic
revision and `ActivityControlDelta` stream items. Roster pages carry matching
control records for their returned actors, and actor detail carries its matching
control record or `null`. This bounded ephemeral overlay is joined by canonical
actor ID by the client; it is not stored inside `ActivityActorSummary` or
persisted with historical Activity records. On server restart, provider runtimes
and their control connections are replaced, so old handles and cancellation
intent cannot be resumed safely. The new runtime generation must re-prove
control eligibility, while ordinary provider reconciliation remains responsible
for observed lifecycle recovery.

Snapshots and deltas also carry a bounded ephemeral cancellation-operation
summary for each selected subtree that is still stopping or incomplete. A
summary contains only the canonical root actor, state (`requested` or
`partial`), residual count, bounded safe message, and an `operationRevision`.
It contains no descendant list or provider identifier. This summary lets a
reconnecting client restore `Stopping` and **Retry remaining** without making
client memory a second source of truth.

### Typed mutation

Add an authorized typed unary RPC named `activity.cancelSubtree` with input:

```text
scope: ActivityScopeRef
scopeId: ActivityScopeId
actorId: ActivityRecordId
expectedControlRevision: NonNegativeInt
```

`scopeId` fences provider/runtime replacement. `expectedControlRevision`
prevents a stale row from targeting a changed handle or a later authoritative
reopening of the same canonical actor without rejecting a click merely because
unrelated Activity detail changed. The client does not submit descendants or
provider IDs.

The successful response reports one of:

- `accepted`: a new bounded cancellation operation owns the subtree;
- `inProgress`: the request joined an overlapping operation; or
- `alreadyTerminal`: the actor completed before mutation admission.

The response acknowledges mutation admission and initial dispatch, not provider
completion. Snapshots/deltas and provider lifecycle events remain authoritative.

Add `activity.retrySubtreeCancellation` for the partial-operation banner. Its
input contains `scope`, `scopeId`, the canonical root actor ID, and the expected
`operationRevision`. The server resolves the residual set from its operation;
the client cannot submit or expand that set. A stale, completed, or replaced
operation fails before provider I/O.

### Errors

Extend the typed Activity error model with bounded codes for:

- cancellation unsupported for the scope or actor;
- stale scope generation;
- stale or missing actor;
- provider disconnected or replaced;
- target handle unavailable;
- partial cancellation; and
- bounded dispatch timeout.

Error messages must not contain native provider identifiers, prompts, commands,
environment values, or raw provider payloads.

## Server Architecture and Ownership

### Activity cancellation service

Add a server-owned Activity cancellation service adjacent to the Activity
projection and provider runtime registry. It owns:

- per-runtime opaque control handles;
- actor-to-handle and work-item-to-handle correlation;
- subtree and overlap calculation;
- cancellation fences;
- bounded operation state and retryable residual sets;
- capability/control overlays for snapshots and deltas; and
- provider-specific dispatch through a narrow trait.

The Activity repository remains the source of truth for observed history. The
cancellation service is the source of truth for ephemeral control eligibility
and in-flight user intent. Neither layer duplicates provider lifecycle state.

The provider-facing trait accepts already validated native handles and exposes
idempotent cancellation primitives. It must not accept canonical record IDs or
perform authorization.

### Admission sequence

Under the Activity scope's lifecycle lock, `activity.cancelSubtree`:

1. authorizes operating access;
2. requires a structured-chat `thread` scope;
3. validates the current `scopeId` and provider runtime instance;
4. loads the current actor and compares `expectedControlRevision`;
5. returns `alreadyTerminal` if the actor is terminal;
6. requires an exact control handle for the selected actor;
7. computes the current descendant and attributable-work closure;
8. installs the cancellation fence before provider I/O;
9. merges or joins any overlapping cancellation operations; and
10. dispatches the selected actor first, followed by known descendants and
    attributable work with bounded parallelism.

Cancelling the selected actor first reduces its opportunity to spawn more work.
The fence handles any child that still appears after that request.

`activity.retrySubtreeCancellation` uses the same lock, revalidates the scope
and operation revision, and dispatches only the operation's current residual
set plus late descendants already admitted under its fence. It never performs a
new upward or outward subtree traversal.

### Overlapping and duplicate requests

Operations are keyed by Activity scope and selected root actor. Repeated clicks
join the existing operation. A request for a descendant already covered by an
ancestor operation joins that operation. A later request for an ancestor
absorbs active descendant operations into one union without dispatching the
same provider handle twice.

No more operations, targets, or retry records may be retained than the existing
bounded actor/work-item limits permit. Terminal targets are removed from the
residual set as authoritative events arrive.

### Late descendants

Provider activity adapters consult the cancellation service after validating a
new actor and its parent relationship but before advertising control
availability. If an ancestor has an active fence, the service adds the new
actor to that operation and immediately schedules its exact handle once known.

If the provider never supplies an exact handle, the operation reports that
actor as a residual partial failure. It does not cancel a broader provider
turn.

### Authorization and maintenance classification

Activity reads and subscriptions remain under `orchestration:read`.
`activity.cancelSubtree` and `activity.retrySubtreeCancellation` require
`orchestration:operate` and are classified as mutations for maintenance
admission, audit, rate limiting, and request metrics.

The mutation travels through typed HTTP/WebSocket RPC in browser and desktop
modes. It does not cross `DesktopBridge` because no privileged desktop
operation is required.

## Codex Provider Design

### Control correlation

The Codex Activity tracker already discovers native descendant thread IDs and
canonicalizes them into actor IDs. Extend its private runtime state to retain,
for each verified descendant:

- native child thread ID;
- current active turn ID when present;
- verified parent thread/actor relationship;
- provider runtime and Activity generation; and
- any scoped background-terminal handles exposed for that child thread.

Canonical actor IDs remain opaque. The server must never attempt to reverse a
canonical or hashed actor ID into a native thread ID.

An actor advertises `available` only while a verified descendant thread has an
active turn ID. Direct `thread/read`/turn history and live turn events update
that handle. Stale turn IDs are removed on authoritative completion.

### Dispatch

Cancellation sends `turn/interrupt` with each target's native child
`threadId` and active `turnId`. The existing root-bound
`CodexRuntime::interrupt_turn` is not reused unchanged; targeted dispatch must
accept an explicitly validated child thread and turn pair.

Attributable background terminals are cleaned only with Codex's child-thread
scoped background-terminal APIs. Lack or failure of that experimental
capability is reported as residual work; it never causes root-thread cleanup.

The selected actor is interrupted first. Remaining descendant turn interrupts
and scoped cleanup requests run under a small concurrency bound. The operation
waits for `turn/completed` with `status: interrupted` or another authoritative
terminal state; an empty interrupt response alone is not completion.

## Claude Provider Design

### Exact `agent_id` to `task_id` correlation

Claude cancellation requires `task_id`, while Activity lineage uses
`agent_id`. Correlation is accepted only through a structured identity chain
within the same session and Activity generation:

1. An Agent/legacy Task tool invocation supplies a stable `tool_use_id`.
2. Its structured async tool result supplies `agentId` and the same
   `tool_use_id` through the authenticated PostToolUse hook.
3. `TaskStartedMessage` supplies `task_id`, `task_type`, and that same
   `tool_use_id`.
4. `SubagentStart` supplies the matching `agent_id` and optional
   `parent_agent_id` used by the Activity graph.

The service accepts the mapping only when the tool is Agent/Task, the result is
an asynchronous launch, the task type is an agent when that field is present,
all identity fields are within existing bounds, and no conflicting mapping has
already been observed. Event order is irrelevant: bounded pending maps join the
four facts by identity as they arrive.

This requires the hook path to observe root Agent/Task PostToolUse results for
control correlation even though root tool activity is not emitted as a child
Activity entry. Secrets and arbitrary tool output remain excluded; the
correlator extracts only bounded status and identity fields.

Nested correlation additionally requires exact source ownership: the nested
stream `parent_tool_use_id` must resolve to an active parent correlation whose
launched agent equals the authenticated nested PostToolUse source `agent_id`.
The Activity-verified `SubagentStart.parent_agent_id` must equal that same
source actor; a root launch instead requires an absent parent. Root and nested
source forms cannot be mixed, and sibling cross-wiring, missing lineage, or
mismatched ownership fails closed. Present invalid hook source/parent fields
are rejected at the authenticated boundary instead of being interpreted as an
absent root source.

Reconciliation uses a bounded dependency fixpoint capped by the correlation
page limit. Each newly installed parent wakes already-present descendants, so
parent, child, and deeper chains settle in the same observation independent of
lexical ID order without an unbounded loop.

Every accepted fact that produces a target install, retirement, or terminal
transition receives a deterministic `claude:control:<sha256>` native event key
before the production event pump. The digest uses length-framed,
domain-separated bounded identity/status fields. It is stable across duplicate
delivery, separates lifecycle statuses, and never exposes raw native IDs;
malformed or rejected facts emit no control key or control effect.
Effect-producing conflicts encode bounded canonical classifications rather
than arbitrary raw status, tool, or task-type labels, making key derivation
total for every install, retirement, and terminal branch. Optional parent and
source identities use explicit `none`/`some` discriminants before the bounded
value. Absence therefore cannot alias a valid provider identity such as the
literal `<root>`.

Terminal retirement atomically removes live tool, agent, and task maps and adds
each identity to generation-scoped fixed tombstone filters. The three filters
each contain 256 `u64` words (2 KiB each; 6 KiB total), reset only with the
Activity generation, and never evict. False positives can only disable
control. Unmatched exact terminal statuses remain bounded at the Activity page
limit without eviction; at saturation, later task identities are tombstoned so
delayed joins cannot displace or bypass retained terminal authority.

Names, descriptions, prompts, timestamps, output paths, and event adjacency are
never correlation keys. If the installed Claude version does not expose the
complete chain, the actor remains `unsupported`.

### Dispatch

Extend Claude's streaming control request model with the provider's
`stop_task { task_id }` request and correlated response handling. The selected
task is stopped first, then every exactly mapped descendant task and
attributable background task under the concurrency bound.

`TaskNotificationMessage(status: "stopped" | "cancelled" | "failed" |
"interrupted")` is authoritative Cancelled, Failed, or Interrupted completion
for a background task. `SubagentStop` must not blindly rewrite a previously
cancelled, interrupted, or failed actor to `completed`; the tracker reconciles
the task terminal state and hook terminal event monotonically. Reordered
notification after an ordinary SubagentStop uses a bounded exact terminal
task-to-agent link to replace Completed with the authoritative lifecycle.

Foreground subagents without a background `task_id` remain observable but do
not advertise Stop. Calling the root Claude `interrupt` request would violate
the selected-subtree boundary and is prohibited as a fallback.

### Version and capability behavior

Use the existing Claude compatibility probe/version policy to determine whether
the streaming `stop_task` control request is supported. Do not issue a
destructive probe. An authoritative unsupported response downgrades targeted
cancellation for that runtime generation and returns a structured error.

## Background Work Semantics

An actor cancellation includes a background work item only when both conditions
hold:

1. Activity has a provider-proven owner relationship from the item to an actor
   in the cancellation subtree; and
2. the provider exposes an exact handle whose cancellation cannot affect work
   outside that subtree.

Unknown operating-system descendants, detached processes, and work without a
stable owner are not killed speculatively. They are reported as residual only
when the provider reports their continued existence. Broad process-tree kill,
root-thread terminal cleanup, and workspace-wide cleanup are forbidden.

## Lifecycle, Concurrency, and Recovery

- Cancellation is idempotent at the canonical actor and native handle levels.
- The selected actor is dispatched before descendants; descendant dispatch is
  bounded and may proceed concurrently.
- A provider event that terminalizes an actor before dispatch turns that target
  into a successful no-op.
- Scope replacement, provider restart, activity disablement, and shutdown
  invalidate handles and cancel pending dispatcher tasks by generation.
- A disconnected provider may retry only while the same runtime instance and
  generation remain current. Reconnect to a replacement runtime never reuses
  old native handles.
- Timeouts bound waiting and report residual state; they do not manufacture a
  terminal lifecycle.
- Late provider completion remains accepted through the ordinary Activity
  projection after an RPC timeout.
- Partial provider failure cannot roll back already accepted interrupts.
  Operation state reports the remaining exact targets honestly.
- A retry uses the residual set plus any late descendants still covered by the
  original fence. It does not recompute upward or outside the selected subtree.
- The fence is removed only when the subtree is terminal, the residual state is
  explicitly abandoned, or its runtime generation is invalidated.

## Failure Semantics

### Already finished

If the selected actor or a descendant is already terminal, cancellation treats
that target as satisfied. Natural completion racing with the click is not an
error.

### Stale client state

A stale `scopeId`, replaced provider instance, mismatched control revision,
missing actor, or reopened actor fails before installing a fence or sending any
provider request.

### Missing exact target

The selected actor must have an exact handle before admission. A descendant
whose handle is delayed remains behind the fence until the handle arrives or
the bounded operation reports it as residual. No guess or root fallback is
allowed.

### Provider disconnection

The operation may wait through a bounded reconnect only for the same provider
runtime instance. Replacement invalidates the operation. The UI keeps the last
observed lifecycle and reports the structured failure.

### Partial failure

Successful member cancellations remain valid. The operation publishes a
bounded residual count and safe display labels, never native IDs. **Retry
remaining** reuses the same subtree fence and targets only residual members.

### Timeout

Timeout ends synchronous waiting, not observation. The Activity stream may
still deliver authoritative terminal events later. The UI must not label an
actor cancelled solely because the request timed out or was accepted.

## Security, Privacy, and Trust Boundaries

- Require authenticated `orchestration:operate` scope.
- Validate the canonical actor against the authenticated Activity scope and
  current generation before resolving a native handle.
- Never accept native provider identifiers from the client.
- Never return native identifiers, prompts, tool inputs, output paths,
  commands, secrets, or raw provider errors in cancellation responses.
- Continue using existing bounds, control-character validation, redaction, and
  provider-instance fencing.
- Audit the canonical scope, actor, provider kind, result class, target count,
  and duration only. Do not log provider payloads or user content.
- Cancellation uses normal typed server RPC. No filesystem, process, network,
  or desktop privilege is granted to the browser.

## Performance and Backpressure

- Subtree discovery operates on the existing bounded Activity actor/work-item
  graph and performs no unbounded provider listing.
- Handle and pending-correlation maps use the existing actor/work-item limits
  and generation cleanup.
- Provider cancellation uses a small fixed concurrency bound and per-request
  deadlines.
- One native handle is dispatched at most once per operation unless it is in a
  user-requested residual retry.
- Control overlays are delta-published only when effective state changes.
- No polling loop is added. Provider events, existing bounded reconciliation,
  and explicit retry drive progress.
- Operation and error summaries remain bounded independently of subtree size.

## Testing

### Contracts and parity

- Encode/decode Activity protocol v2 capability, actor control state, mutation
  inputs, cancellation-operation summaries, success dispositions, and
  structured errors.
- Update TypeScript/Rust RPC method and schema parity fixtures.
- Reject native IDs, invalid timestamps, excessive text, unknown control
  states, and malformed scopes.
- Prove protocol v1/v2 version mismatch fails closed.

### Activity cancellation service

- Select exactly the requested actor and canonical descendants.
- Exclude the root, ancestors, siblings, unrelated work, and other scopes.
- Include only provider-attributed work owned by subtree actors.
- Install the fence before dispatch and catch late descendants.
- Cover duplicate, overlapping ancestor/descendant, and absorbed operations.
- Cover natural completion races, actor reopening, stale scope, provider
  replacement, disablement, reconnect, timeout, and shutdown.
- Bound concurrency, retained handles, residual state, and retry work.
- Prove partial failure never expands the target set.

### Codex provider

- Assert `turn/interrupt` receives the child `threadId` and active child
  `turnId`, never the root thread ID.
- Cancel a multi-level descendant tree and catch a late-spawned child.
- Reject missing, terminal, stale, hashed-without-private-map, cross-generation,
  and mismatched turn handles.
- Treat `turn/completed(interrupted)` as authoritative.
- Cover already-completed and interrupt-error races.
- Clean only attributable background terminals for child threads when the
  scoped experimental capability exists.
- Report scoped cleanup failure without invoking root cleanup.

### Claude provider

- Correlate `agentId` to `task_id` only through matching Agent/Task tool-use
  identity across multiple event orderings.
- Cover concurrent launches with identical names, roles, descriptions, and
  prompts to prove no semantic guessing occurs.
- Reject missing links, conflicts, duplicate task IDs, wrong session,
  unsupported task type, stale generation, and malformed tool output.
- Assert `stop_task` receives only correlated task IDs.
- Cancel nested mapped subagents and mapped background work.
- Keep foreground/unmapped subagents observable but not cancellable.
- Reconcile `task_notification(stopped)` and `SubagentStop` without changing a
  cancelled actor to completed.
- Downgrade cleanly when the installed Claude runtime lacks `stop_task`.

### RPC, authorization, and maintenance

- Require `orchestration:operate` for cancellation and residual retry; prove
  read-only credentials cannot invoke either mutation.
- Classify the method as a mutation in maintenance mode.
- Reject terminal scopes in the first release.
- Prove stale or cross-scope input sends no provider request.
- Redact native identities and provider payloads from responses, logs, and
  metrics.

### Client runtime and web UI

- Render Stop only for active actors whose state is `available`.
- Use sibling row/detail and Stop buttons with correct keyboard navigation,
  focus rings, tooltip, and accessible subtree-count label.
- Keep Stop visible without hover-only discovery.
- Prevent Stop clicks from navigating to detail.
- Render server-authoritative `Stopping` across the selected subtree.
- Disable duplicate actions and join `inProgress` responses.
- Move actors to Done only after authoritative provider terminal state.
- Cover already-finished, stale, disconnected, timeout, unsupported, and
  partial outcomes.
- Render **Retry remaining** and prove it cannot target outside the original
  subtree.
- Verify responsive row layout in the right panel and sheet.

### End-to-end

- Run Codex and Claude structured-provider fixtures with at least one parent,
  two siblings, nested descendants, and attributable background work.
- Cancel one sibling and prove its subtree stops while the root and other
  sibling continue producing activity.
- Spawn a descendant during cancellation and prove the fence catches it.
- Reconnect during cancellation and recover server-authoritative control state.
- Exercise keyboard-only cancellation and screen-reader labels.

## Living Documentation Changes

Implementation must update at least:

- `docs/architecture/activity-observation.md` to replace the read-only invariant
  with capability-gated control ownership, mutation flow, overlay state, and
  generation fencing;
- `docs/architecture/rpc-and-orchestration.md` for the new operating mutation
  and cancellation lifecycle;
- `docs/providers/codex.md` for child-thread/turn control correlation;
- `docs/providers/claude.md` for exact Agent tool/task correlation and
  `stop_task` support; and
- `docs/user/workspace-ui.md` for the Subagents row action, pending state,
  partial failure, and accessibility behavior.

The implementation must also update public contract examples, RPC parity
fixtures, and any capability tables that still describe Activity as
inspect-only.

## Affected Packages

- `packages/contracts`: Activity protocol v2, control state, mutation, and
  errors.
- `apps/server`: authorization, maintenance classification, cancellation
  service, provider handle registry, provider dispatch, projection overlays,
  and RPC.
- `packages/client-runtime`: typed mutation operation, pending/retry state, and
  Activity stream integration.
- `apps/web`: roster controls, status/error UI, accessibility, and tests.

`apps/desktop` requires no native bridge or Rust host change unless ordinary
desktop integration fixtures mirror RPC capability data.

## Acceptance Criteria

1. Every active structured-chat actor with an exact native target shows a Stop
   button in the Subagents roster.
2. Clicking Stop cancels the selected actor and every observable descendant.
3. Parent, sibling, root, terminal, and unrelated provider work are never
   targeted.
4. Descendants created after the click but under the selected actor are caught
   by the cancellation fence.
5. Codex cancellation uses child thread and active child turn IDs.
6. Claude cancellation uses only authoritatively correlated background task
   IDs.
7. Missing exact correlation never falls back to root interruption or semantic
   guessing.
8. The UI displays server-authoritative `Stopping` and provider-authoritative
   terminal lifecycle.
9. Duplicate clicks are idempotent; already-finished races succeed harmlessly.
10. Partial failure identifies residual work and offers a retry constrained to
    the original subtree.
11. Native provider identities and sensitive payloads never cross the client
    boundary or enter logs.
12. Thread-scoped cancellation requires `orchestration:operate`; terminal
    Activity remains read-only.
13. Focused provider, server, client-runtime, web, authorization, and end-to-end
    tests pass.
14. `vp check` and `vp run typecheck` pass, along with applicable Rust format,
    test, and Clippy checks required by the repository.
