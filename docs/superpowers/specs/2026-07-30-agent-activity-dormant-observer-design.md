# Agent Activity Dormant Observer Design

**Date:** 2026-07-30

**Status:** Approved design, pending implementation plan

**Supersedes:** The terminal disable/re-enable transport and reconstruction
behavior in
`docs/superpowers/specs/2026-07-30-agent-activity-toggle-design.md`. All other
decisions in that design remain authoritative.

## Summary

Standardize the disabled lifecycle for already-instrumented Claude, Codex, and
OpenCode terminals around a minimal dormant observer.

When activity monitoring is disabled, an existing observer retains only the
transport needed to preserve a deterministic live boundary. It continues
bounded transport-level draining but performs no provider activity decoding,
tracker mutation, reconciliation, projection, persistence, broadcast, or
per-event logging. Re-enabling establishes a provider-specific boundary before
the observer can publish in the new activity generation.

Terminals launched while activity monitoring is disabled remain direct,
uninstrumented launches. They create no dormant observer and must be reopened
after monitoring is enabled to expose activity.

This approach deliberately rejects disconnect-and-reconstruct behavior.
Claude hooks do not provide reliable replay, Codex history reconstruction has
incomplete and ambiguous boundaries, and OpenCode's SSE client exposes neither
event IDs nor a `Last-Event-ID` resume contract.

## Goals

- Make disable/re-enable behavior predictable under provider traffic, rapid
  toggles, connection loss, and terminal shutdown.
- Prevent disabled-period detail from being buffered, reconstructed, or
  published after re-enabling.
- Preserve already collected history without disrupting the underlying agent
  terminal.
- Keep disabled resource use bounded and limited to transport integrity.
- Apply one behavioral contract to Claude, Codex, and OpenCode while preserving
  their transport-specific implementations.
- Produce transition-only diagnostics that prove the effective state without
  adding activity hot-path logging.

## Non-goals

- Guaranteeing continuity after an unresumable provider transport failure.
- Reconstructing activity produced while monitoring was disabled.
- Retrofitting instrumentation into terminals launched while disabled.
- Sharing provider transport code through a common trait or protocol.
- Adding Cursor or Grok activity support.
- Terminating or restarting the underlying agent process when the setting
  changes.

## Decision

Use a **shared lifecycle contract with provider-specific boundary adapters**.
Do not use a zero-retention transport policy and do not reconnect from provider
history.

The alternatives were rejected as follows:

1. **Zero retained transport:** resource-minimal, but safe only if disabling is
   a hard terminal-observation reset. It loses live continuity and cannot be
   repaired consistently across the supported providers.
2. **Disconnect and reconstruct:** appears to retain continuity but depends on
   incomplete histories, pagination, provider timestamps, and ordering
   assumptions. It is not an acceptable correctness boundary.
3. **Minimal dormant observer:** retains a small amount of transport I/O but
   gives each provider an explicit new-live boundary without activity backfill.
   This is the approved approach.

## Shared Lifecycle Contract

### States

Each already-instrumented terminal observer has one of these logical states:

- `Live { generation, epoch }`: activity processing may request admission for
  the current controller generation.
- `Draining { generation, epoch }`: old-generation admissions are closing; no
  new activity work may begin.
- `Dormant { generation, epoch }`: the transport is drained and discarded, but
  activity processing is prohibited.
- `Enabling { generation, epoch }`: a provider-specific boundary is being
  established; activity processing remains prohibited.
- `Unavailable { generation, epoch }`: a safe boundary could not be
  established. The observer remains unobserved and retries only bounded
  transport recovery.

These states describe a contract, not a new persistence model. They remain
in-memory and are bounded by live instrumented terminals.

### Generations and epochs

The existing `AgentActivityController` remains the authoritative environment
feature gate.

- A controller **generation** fences activity admission and publication across
  environment setting transitions.
- A per-observer **epoch** fences provider transport instances. Replacing or
  losing a transport advances the epoch.
- Activity may publish only when both generation and epoch are current.
- Responses and events from an earlier generation or epoch are discarded.

The dormant transport is not registered as an activity stream. Only live
activity processing owns an `AgentActivityStreamRegistration`, so controller
disable can drain to zero without terminating the provider transport.

### Dormant hot path

While dormant, the observer may perform only work required for safe transport
operation:

- authenticate an incoming request or preserve an authenticated connection;
- apply existing body/frame bounds;
- consume transport framing and heartbeats;
- reconnect a failed dormant transport with bounded backoff; and
- observe terminal cancellation.

It must not:

- decode provider payloads into activity events;
- mutate an activity tracker;
- query provider history, sessions, children, messages, or status for
  reconciliation;
- obtain activity admission;
- write or read the activity repository;
- publish activity RPC events;
- buffer provider event bodies for later processing; or
- emit a log per discarded event.

## State Transitions

### Disable

1. Persist the environment setting.
2. Move the controller to draining and advance its generation.
3. Stop new activity admission and close live stream registrations.
4. Wait for admitted projection work to drain.
5. Move existing provider observers to dormant mode and report
   `observed=false`.
6. Continue bounded transport draining outside activity stream accounting.
7. Emit one effective-disabled transition event.

After the effective-disabled event, no mutation from the old generation or
epoch may be persisted or broadcast.

### Enable

1. Persist the environment setting and advance the controller generation.
2. Notify existing dormant observers.
3. Move each observer to enabling without granting activity admission.
4. Establish the provider-specific boundary.
5. Advance or confirm the observer epoch.
6. Register live activity processing for the current controller generation.
7. Report `observed=true` only after the boundary and registration succeed.
8. Emit one effective-enabled transition event with bounded success and
   failure counts.

Activity occurring before an observer completes step 4 belongs to the disabled
interval. It is intentionally not reconstructed.

### Terminal shutdown

Terminal cancellation wins over dormant recovery or enabling. It closes the
transport/helper, invalidates the epoch, releases its bounded observer state,
and never publishes a late terminal event.

## Provider Adapters

### Claude

Claude already substantially implements the approved dormant behavior through
its authenticated HTTP hook listener.

- Keep the bound listener and correlation state for an already-instrumented
  terminal.
- Authenticate before accepting a hook.
- When disabled, return immediately without validating content type, reading
  the body, decoding JSON, enqueueing, mutating the tracker, or publishing.
- The request's controller generation check is its live boundary. A request
  admitted after enable belongs to the new generation; earlier requests cannot
  publish.
- A listener that cannot remain bound reports unavailable. It does not attempt
  hook history replay.

The implementation should primarily formalize and regression-test this
existing behavior rather than redesign the Claude transport.

### Codex

Codex retains its authenticated app-server WebSocket and minimal correlation
state.

- The connection reader continues consuming frames while dormant.
- Dormant notifications are discarded before activity decoding or tracker
  mutation.
- Re-enable sends a lightweight ordered JSON-RPC barrier on the retained
  connection.
- Notifications preceding the barrier response remain discarded.
- Only after the response is correlated to the current connection epoch may
  live activity admission begin.
- Reconnect or a failed barrier advances the epoch. Recovery never uses
  `thread/list`, `thread/read`, provider timestamps, or detail-history
  reconstruction to synthesize the disabled interval.

The exact barrier method must be supported by the pinned Codex protocol and
covered by a fixture that proves notification/response ordering. It must not
have user-visible side effects.

### OpenCode

OpenCode retains its authenticated SSE connection and helper/root ownership
while dormant.

- The dormant reader consumes bounded SSE framing and discards event data
  without activity decoding.
- Re-enable creates a replacement authenticated SSE subscription while the
  dormant connection continues draining.
- The replacement must receive and validate OpenCode's `server.connected`
  handshake before it is eligible to become live.
- The observer atomically advances the epoch, makes the replacement connection
  live, and then closes the dormant connection.
- No REST session/message reconciliation runs during disable or enable.
- If replacement subscription fails, the observer remains unavailable and the
  old connection remains dormant until bounded retry or terminal cancellation.

The OpenCode server documents the `/event` stream as sending
`server.connected` immediately and then forwarding live bus events:
<https://github.com/anomalyco/opencode/issues/11616>. The implementation must
still test the pinned OpenCode version rather than assuming current upstream
behavior.

OpenCode's local remote-client abstraction currently returns decoded JSON
values and resets an ended SSE response without an event cursor. It must be
split or extended so dormant draining can discard bounded SSE frames without
constructing activity values and so two connections can participate in the
bounded enable handoff.

## Failure Semantics

Transport failures must be explicit and conservative:

- advance the observation epoch immediately;
- reject late work from the failed epoch;
- keep `observed=false` until a new boundary succeeds;
- use bounded exponential backoff with cancellation;
- retain persisted activity history unchanged;
- never claim reconstructed continuity; and
- never reopen activity admission merely because a transport reconnected.

A provider failure is isolated to its observer. It does not disable activity
for other terminals or providers in the same environment.

If a provider cannot establish a safe boundary, the environment setting may
remain enabled while that observer remains unavailable. The transition log
reports the bounded failure count.

## Performance and Memory

- Dormant state is bounded by the number of live, previously instrumented
  terminals.
- One dormant transport is retained per such terminal. OpenCode may briefly
  use two SSE connections only during enable handoff.
- No disabled-period activity payload, decoded event, or reconstruction cache
  is retained.
- Existing request, frame, and decoder size limits remain authoritative.
- Reconnect backoff has a fixed maximum and does not create a timer per event.
- Activity trackers and reconciliation intervals do not run while dormant.
- No trace call is added to the per-event discard path.
- Transition diagnostics contain only safe primitive counters and identifiers;
  never credentials, hook bodies, provider frames, prompts, or terminal output.

## Logging

Reuse the existing transition event family:

- `agent_activity_change_requested`
- `agent_activity_disabled`
- `agent_activity_enabled`
- `agent_activity_transition_failed`

Add only bounded aggregate fields needed to audit the dormant contract:

- provider;
- controller generation;
- observation epoch;
- dormant, resumed, unavailable, and failed observer counts;
- transition duration; and
- transition cause.

Repeated transport failures within one transition are deduplicated and capped.
Successful discarded events produce no log.

## Testing Strategy

### Shared lifecycle

- Disable drains live registrations while the transport remains outside stream
  accounting.
- Old generations and epochs cannot persist or broadcast.
- Enable cannot report observed before its provider boundary succeeds.
- Rapid disable/enable/disable converges on the latest requested state.
- Terminal cancellation wins over recovery and enabling.
- Repeated toggles do not accumulate tasks, connections, registrations,
  buffers, or timers.

### Claude

- Disabled hooks return without reading or decoding their bodies.
- A request admitted before disable cannot publish after effective disable.
- The first post-enable request uses the new generation.
- Listener failure never triggers replay or unbounded retry.

### Codex

- Notifications before and during the JSON-RPC barrier are discarded.
- A post-barrier notification is published exactly once.
- A stale barrier response from a replaced epoch is rejected.
- Barrier timeout or disconnect leaves the observer unavailable.
- No history RPC or reconciliation occurs during disable/re-enable.

### OpenCode

- Dormant SSE frames are bounded and discarded without activity tracker work.
- A replacement connection cannot become live before `server.connected`.
- Old-connection events lose the epoch race after handoff.
- Failed handoff retains dormant behavior and publishes nothing.
- Repeated handoffs return to one connection and one reader.
- No session, child, status, or message reconciliation occurs during
  disable/re-enable.

### Integration and resource evidence

- A terminal launched disabled creates no observer, helper, hook, or provider
  activity connection.
- Multiple environments remain isolated.
- Disabled traffic produces no projection, database queue, broadcast, or RPC
  activity work.
- Task, connection, registration, and database-queue counts remain bounded
  across repeated transitions.
- Chat and terminal activity surfaces disappear immediately and reappear only
  when their environment is enabled.
- Retained history remains visible without disabled-period detail.
- Transition logs are bounded and contain no sensitive payloads.

## Verification

- Run focused Rust provider-terminal, activity-controller, RPC, settings, and
  resource tests.
- Run focused web settings and activity-surface tests.
- Run `vp test`.
- Run `vp check`.
- Run `vp run typecheck`.
- Build and exercise the desktop application.
- Use Computer Use to verify Claude, Codex, and OpenCode chat/terminal surfaces,
  per-environment isolation, retained history, transition logs, and repeated
  disable/re-enable behavior.

## Acceptance Criteria

1. Claude, Codex, and OpenCode implement the shared dormant lifecycle contract.
2. Terminals launched disabled create no activity-specific backend resources.
3. Already-instrumented terminals retain only the approved minimal dormant
   transport.
4. Disabled traffic performs no activity decoding, reconciliation, projection,
   persistence, broadcast, buffering, or per-event logging.
5. Re-enable publishes only after the provider-specific boundary succeeds.
6. Disabled-period detail is never reconstructed or replayed.
7. Old controller generations and observer epochs cannot publish.
8. Provider failure leaves that observer explicitly unavailable without
   affecting other providers.
9. Persisted history remains intact.
10. Resource and logging behavior remains bounded under repeated toggles and
    connection failures.
11. Cursor and Grok remain outside the feature.
12. Repository and desktop UI verification gates pass.
