# Per-Environment Agent Activity Toggle Design

**Date:** 2026-07-30

**Status:** Approved design, pending implementation plan

## Summary

Add an **Agent activity for this environment** toggle to **Settings → Agents**.
The setting controls the floating agent/background-task toolbar and the
activity-specific backend work that supplies it. It is persisted independently
by each BiBCode environment and defaults to enabled so existing installations
retain their current behavior.

Disabling the feature immediately hides the chat and AI-terminal activity UI,
closes its RPC streams, stops activity normalization and projection, prevents
new activity database writes, and avoids instrumenting newly opened provider
terminals. Existing activity history is retained. Re-enabling resumes collection
from that point forward and does not backfill events produced while disabled.

The feature remains limited to Claude, Codex, and OpenCode. It does not add
Cursor or Grok activity support.

## Goals

- Let users opt out of agent activity monitoring for one environment without
  affecting other connected environments.
- Remove both the visible activity UI and avoidable backend resource use.
- Apply disablement immediately without stopping the underlying agent session
  or terminal process.
- Retain previously collected activity history.
- Resume supported live observation after re-enabling.
- Prove through low-overhead structured trace events whether the environment
  reached the requested effective state.
- Preserve reliable behavior during concurrent events, reconnects, settings
  failures, provider failures, and server restarts.

## Non-goals

- Disabling Claude, Codex, or OpenCode themselves.
- Stopping an active chat, subagent, task, or terminal.
- Deleting existing activity history.
- Buffering or reconstructing activity emitted while monitoring was disabled.
- Retrofitting observation into provider terminals that were launched without
  the required launch-time instrumentation.
- Adding Cursor or Grok activity support.
- Logging individual activity events, prompts, terminal output, credentials, or
  other sensitive provider data.

## Approved Decisions

| Decision | Approved choice |
| --- | --- |
| Setting scope | Per environment/server |
| Default | Enabled |
| Disable timing | Immediate |
| Existing history | Retained |
| Disabled-period events | Neither buffered nor backfilled |
| Re-enable behavior | Resume supported still-running sessions and terminals |
| Architecture | Live shared backend feature gate |
| Providers | Claude, Codex, and OpenCode only |
| Trace requirement | Log requested and effective state transitions |
| Trace overhead | No activity hot-path logging or unbounded state |

## User Experience

### Settings row

Add one row to **Settings → Agents**:

- **Title:** Agent activity for this environment
- **Description:** Show live agent and background-task activity in chats and AI
  terminals. Disabling this stops activity monitoring and collection.
- **Control:** Boolean switch
- **Default:** On
- **Reset:** Use the existing reset control when the persisted value differs
  from the default

The switch updates the selected environment's server settings. It is not a
browser-only preference.

The UI optimistically hides activity surfaces when the user switches the
feature off. If the settings update fails, the switch and surfaces return to
their previous state and use the existing settings error treatment.

### Enabled state

The existing activity experience is unchanged:

- chat and eligible provider-terminal docks subscribe when mounted;
- the collapsed and expanded toolbar remains available when activity is
  present; and
- roster and record detail continue to use the Activity right panel.

### Disabled state

While disabled:

- no chat or terminal activity toolbar or placeholder is rendered;
- any open Activity right panel closes immediately;
- Activity cannot be reopened through stale UI state or a deep-linked panel
  state;
- frontend activity atoms and RPC streams have no mounted consumers;
- cached activity snapshots, roster pages, and detail pages for that
  environment are evicted from client memory; and
- provider chats and terminals otherwise continue normally.

### Re-enabled state

The UI may subscribe again after the server reports the setting enabled.
Retained history is visible, followed by activity collected from the new
observation epoch. The UI must not imply that the disabled interval is
complete; no activity from that interval is backfilled.

## Terminal Observation Constraint

Terminal observation is negotiated at process launch:

- Codex uses remote app-server/TUI transport.
- Claude uses authenticated HTTP hooks supplied through a launch-time settings
  overlay.
- OpenCode uses an authenticated `serve`/`attach` transport.

These mechanisms cannot be added safely to an already-running direct CLI
process. Therefore:

1. A terminal already instrumented when the feature is disabled stops activity
   parsing, publication, projection, and storage immediately.
2. Transport that is necessary to keep that existing terminal functional may
   remain in a minimal dormant state until the terminal exits.
3. A terminal launched while the feature is disabled runs directly, without
   activity instrumentation or activity helper processes.
4. Re-enabling resumes an already-instrumented terminal when its provider
   transport supports reattachment.
5. A terminal launched during the disabled interval must be reopened before it
   can expose activity.

This exception is required to satisfy the higher-priority rule that changing
the setting must not terminate or corrupt an active terminal. Dormant transport
is not allowed to normalize events, publish deltas, write activity data, or
retain an event backlog.

## Architecture

### Persisted contract

Add this field to the shared server settings contract and patch contract:

```text
enableAgentActivity: boolean
```

Decoding defaults the field to `true`, including for settings files written by
older versions. The native settings validator, defaults, persistence, update
publication, TypeScript contracts, and Rust settings domain must agree on the
field.

### AgentActivityController

Each production environment owns one shared `AgentActivityController`. It is
created before provider runtimes, terminal supervision, and activity RPC
registration. Its initial state comes from the persisted server setting.

The controller owns:

- the desired and effective enabled state;
- a monotonically increasing observation generation;
- admission to the activity projection;
- a bounded count of in-flight projection operations;
- a change notification used by RPC streams and observer owners; and
- bounded restart descriptors for live, previously instrumented terminals.

It does not own activity records, provider payloads, prompts, transcripts, or
an event queue.

Consumers read an inexpensive snapshot for fast-path rejection and subscribe
only when they need lifecycle notifications. No component polls the settings
file.

Closing the gate also releases transient projection state that can be
reconstructed from the retained repository. Persistent history remains the
only disabled-state activity storage, apart from bounded restart descriptors
for still-live instrumented terminals.

### Startup ordering

Production startup must load and validate settings before constructing
activity-aware provider services.

When disabled at startup:

- the gate starts closed;
- activity RPC methods are registered but reject activity work without a
  database read;
- provider chat adapters start without active activity projection work;
- terminal launch preparation passes provider terminals through directly; and
- no transient observer or activity worker is started.

The existing activity repository and projection value may still exist as
lightweight service objects so RPC registration and later enabling do not
require rebuilding the entire production runtime. They perform no background
work while the gate is closed.

### Provider chat boundary

Provider protocol parsing that is required for the conversation continues.
Activity-specific adapters check the gate before performing child-agent or
background-task extraction and normalization. This avoids the optional work
without breaking ordinary chat rendering.

The projection enforces the gate again at its public mutation boundary. This
second check is authoritative and prevents an adapter race or future caller
from writing while disabled.

### Terminal boundary

The provider-terminal supervisor checks the gate before capability probing,
helper startup, hook generation, executable pinning, or observer preparation.
When disabled, new launches use `PassThrough`.

Observer ownership exposes a bounded lifecycle operation for disable and
re-enable:

- disable cancels activity workers and closes activity client connections;
- required terminal transport may enter the documented dormant state;
- re-enable uses the retained live-generation descriptor to reconnect where
  possible; and
- terminal exit removes its descriptor and resources.

Restart descriptors contain only the minimum non-sensitive information needed
to identify a live instrumented generation and reconnect its existing
transport. They are bounded by the number of live terminals and are never
persisted or used as an event buffer.

### RPC boundary

Activity snapshot, roster, detail, and streaming RPC methods consult the same
controller.

When the feature becomes disabled:

- active streams receive a structured `featureDisabled` termination and stop;
- new activity requests return `featureDisabled` without reading the activity
  repository; and
- any response racing with disablement is fenced by the observation
  generation.

The frontend normally avoids these calls because it unmounts the consumers.
The server-side rejection remains necessary for stale clients, mixed-version
clients, and race safety.

## State Transitions

### Disable sequence

1. Validate and persist the environment settings patch.
2. Close activity admission and advance the observation generation.
3. Reject new activity operations and wait for the bounded in-flight projection
   count to drain.
4. Perform one final bounded projection that transitions unresolved active
   records to `interrupted` with a monitoring-disabled reason.
5. Terminate activity RPC streams and notify activity service owners.
6. Stop or dormantly park active provider-terminal observers according to the
   terminal constraint.
7. Publish the updated settings to clients.
8. Emit the effective-disabled trace event.

The admission gate closes before cleanup work, so late provider events cannot
extend the disabled transition indefinitely. Cleanup errors do not reopen the
gate.

### Re-enable sequence

1. Validate and persist the environment settings patch.
2. Advance the observation generation and open activity admission.
3. Notify activity-aware provider sessions.
4. Best-effort reattach eligible, still-live instrumented terminals.
5. Publish the updated settings to clients.
6. Emit the effective-enabled trace event with successful and failed resume
   counts.

Re-enable creates a new observation epoch. Events emitted while disabled are
not replayed. A provider-specific reattachment failure does not close the gate
for providers that succeeded or for new sessions.

### Race fencing

An event may be accepted only for the controller generation in which its
activity operation began. Closing the gate prevents new admissions, advances
the generation, and waits for already admitted mutations to finish before
effective disablement is logged.

The projection validates admission immediately before persistence and
broadcast. This establishes the guarantee:

> After `agent_activity_disabled` is emitted, no activity mutation from an
> earlier generation can be stored or broadcast.

## Retention and History

Disabling does not delete scopes, actors, work items, entries, or retention
metadata. The existing retention policy continues to govern stored history.
The disable transition's final interruption records are ordinary bounded
activity mutations.

The server does not record disabled-period events. Re-enabling reads retained
history normally and appends only new-epoch observations.

## Trace and Diagnostics

Emit structured events through the existing trace pipeline:

- `agent_activity_change_requested`
- `agent_activity_disabled`
- `agent_activity_enabled`
- `agent_activity_transition_failed`

Startup emits the effective initialized state using the enabled or disabled
event name with a startup cause.

Effective-state events are emitted only after the gate reaches that state.
Fields are limited to safe primitive values:

- enabled state and transition cause;
- environment identifier;
- settings generation;
- observation generation;
- transition duration;
- closed subscription count;
- stopped, dormant, resumed, and failed observer counts; and
- finalized active-record count.

No prompt, response, command, terminal output, provider payload, credential,
secret, or transcript data is logged.

### Performance and memory rules

- No trace call is added to the per-activity-event hot path.
- Logs occur only at startup, settings transitions, and bounded transition
  failures.
- Transition diagnostics use counters rather than lists of session or record
  identifiers.
- Failure logging is deduplicated and capped for each transition.
- The existing non-blocking trace path is used; this feature creates no new log
  queue, cache, worker, or timer.
- Restart metadata is bounded by live instrumented terminals.
- No disabled activity payload is buffered for diagnostics or later replay.
- With no setting transition, tracing adds no recurring work.

## Error Handling

### Settings persistence failure

If validation or persistence fails, the controller keeps its previous desired
and effective state. The frontend rolls back its optimistic switch state and
uses the existing settings error presentation.

### Disable cleanup failure

The activity gate remains closed. Further activity operations are rejected.
Failures are logged through a bounded transition warning. Terminal cleanup
must prefer a dormant transport over disrupting the terminal process.

The effective-disabled event may still be emitted when the hard guarantees
(closed admission, no projection, no storage, no activity streams) hold and
only an approved dormant transport remains. Its dormant count makes the
exception observable.

### Reattachment failure

The environment remains effectively enabled. New activity can be collected,
and successful providers continue. Each failed provider reattachment is
counted and produces a bounded warning without sensitive detail. A terminal can
be reopened to obtain a fresh instrumented launch.

### Server restart

The persisted setting is authoritative. A disabled environment restarts with a
closed gate before any activity-aware service is allowed to start.

## Compatibility

- Older settings documents decode with `enableAgentActivity = true`.
- The server remains authoritative even if an older frontend continues issuing
  activity RPC calls.
- A newer frontend connected to a server that does not expose the setting uses
  the shared contract's enabled default and existing activity behavior.
- Existing activity history and migrations remain valid.
- The activity model and provider-capability negotiation remain unchanged.

## Testing Strategy

### Contract and settings tests

- Decode missing `enableAgentActivity` as `true`.
- Decode and patch explicit `true` and `false`.
- Reject non-boolean values.
- Persist and reload the setting.
- Prove settings updates affect only their target environment.
- Prove a disabled startup never transiently opens the gate.

### Controller and projection tests

- Close admission immediately and advance the generation.
- Drain already admitted mutations before effective disablement.
- Reject late and stale-generation events without persistence or broadcast.
- Finalize unresolved active records exactly once.
- Preserve completed history.
- Open a new epoch without replaying disabled-period events.
- Bound restart descriptors and transition diagnostics.

### RPC tests

- End active streams with `featureDisabled`.
- Reject snapshot, roster, and detail calls without a repository read.
- Prevent racing old-generation responses.
- Allow subscriptions and reads again after re-enabling.

### Provider runtime tests

For Claude, Codex, and OpenCode:

- skip activity-specific chat normalization while disabled;
- continue ordinary provider chat operation;
- prevent activity projection and persistence;
- resume new-epoch chat observation when enabled; and
- isolate one provider's reattachment failure from the others.

### Provider terminal tests

For Claude, Codex, and OpenCode:

- return pass-through before probes or helpers when disabled;
- stop activity workers for an already instrumented terminal;
- retain only transport required to keep that terminal functional;
- perform no activity parsing, publication, persistence, or buffering while
  dormant;
- resume a supported instrumented terminal after re-enabling;
- leave terminals launched while disabled unmonitored after re-enabling; and
- release dormant transport and restart metadata when the terminal exits.

### Frontend tests

- Render the Settings → Agents switch with its enabled default.
- Send a per-environment settings update.
- Optimistically remove chat and terminal docks.
- Close an open Activity right panel.
- Release activity atom and RPC stream consumers.
- Evict the environment's cached snapshots, roster pages, and detail pages.
- Prevent stale panel state from reopening Activity.
- Roll back the switch and surfaces after a failed settings update.
- Restore eligible surfaces and retained history after re-enabling.

### Trace and resource tests

- Emit requested and effective events at startup and transitions.
- Never emit an effective event before the gate reaches the state.
- Include bounded counters and exclude sensitive or high-volume payloads.
- Deduplicate and cap failure logs.
- Assert that activity event volume does not increase transition log volume.
- Assert that disabled activity causes no new projection, database write,
  broadcast, subscription, helper launch, or unbounded memory growth.

### Verification

- Run focused TypeScript and Rust contract, settings, activity, provider, and
  terminal-supervisor suites.
- Run activity load/concurrency coverage with the gate enabled and disabled.
- Run `vp check`.
- Run `vp run typecheck`.
- Build the desktop application.
- Use Computer Use to verify the per-environment toggle, immediate toolbar and
  panel removal, Claude/Codex/OpenCode chat and terminal behavior, trace
  evidence, retained history, and re-enable behavior.

## Acceptance Criteria

The design is implemented when:

1. Each environment persists an enabled-by-default agent activity setting.
2. Disabling immediately removes all chat and terminal activity UI.
3. After effective disablement, the server performs no new activity parsing,
   projection, broadcast, database write, or RPC query work.
4. Disabled environments retain no reconstructible activity cache or event
   buffer beyond bounded live-terminal restart descriptors.
5. New provider terminals launched while disabled receive no activity
   instrumentation or helper process.
6. Existing terminals continue functioning, with only the approved dormant
   transport exception.
7. Existing activity history remains intact.
8. Re-enabling begins a new observation epoch without backfill and resumes
   supported live instrumentation.
9. Structured trace events prove the effective state without adding hot-path,
   unbounded memory, or high-volume logging overhead.
10. Claude, Codex, and OpenCode pass focused backend and UI coverage.
11. Cursor and Grok receive no activity integration.
12. Repository verification gates pass.
