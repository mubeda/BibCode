# Independent Chat and AI Terminal Agent Activity Controls

**Date:** 2026-08-04

**Status:** Approved design, pending implementation plan

## Summary

Replace the single **Agent activity for this environment** setting with two
fully independent, per-environment settings in **Settings → Agents**:

- **Chat agent activity** controls structured agent and background-task
  activity for provider chats. It defaults to enabled.
- **AI Terminal agent activity** controls activity observation for managed
  provider terminals. It defaults to disabled.

Both settings are experimental and display an **Experimental** badge next to
their titles. Every combination of the two settings is supported. Disabling
one source must stop its UI, RPC work, projection, persistence, and observer
work without affecting the other source or the underlying chat or terminal.

Existing activity history is retained. Activity produced while a source is
disabled is neither buffered nor backfilled.

## Goals

- Let users enable or disable Chat and AI Terminal activity independently for
  each environment.
- Keep the existing Chat activity experience enabled by default.
- Make AI Terminal instrumentation opt-in by default.
- Label both controls as experimental in the settings UI.
- Stop avoidable backend work for only the disabled source.
- Keep source transitions immediate, race-safe, and non-disruptive to active
  chats and terminal processes.
- Preserve existing activity history and the existing activity wire model.

## Non-goals

- Disabling a provider, provider chat, terminal, subagent, or background task.
- Deleting previously collected activity.
- Reconstructing events from a disabled interval.
- Adding activity support to providers that do not already support it.
- Changing the activity record model, toolbar layout, or right-panel content.
- Instrumenting an already-running direct terminal that was launched while AI
  Terminal activity was disabled.

## User Experience

### Settings rows

The Agents settings card contains two rows where the single activity row
currently appears.

The first row is:

- **Title:** Chat agent activity
- **Badge:** Experimental
- **Description:** Show live agent and background-task activity in the Chat
  panel. Disabling this stops Chat activity monitoring and collection.
- **Control:** Boolean switch
- **Default:** On
- **Reset:** Restore the shared Chat default

The second row is:

- **Title:** AI Terminal agent activity
- **Badge:** Experimental
- **Description:** Show live agent and background-task activity in AI
  Terminals. Disabling this stops AI Terminal activity monitoring and
  collection.
- **Control:** Boolean switch
- **Default:** Off
- **Reset:** Restore the shared AI Terminal default

Each switch has an accessible name matching its title. The badge is visible
text, not part of the switch's accessible name. Each row updates the primary
environment's server settings through the existing optimistic settings path.

### Independent behavior

All four combinations are valid:

| Chat | AI Terminal | Behavior |
| --- | --- | --- |
| On | Off | Structured Chat activity works; provider terminals launch without activity instrumentation. |
| Off | On | Chat activity is not collected or shown; eligible provider terminals still expose activity. |
| On | On | Both existing activity experiences work. |
| Off | Off | Neither source performs activity work; chats and terminals otherwise work normally. |

Turning off Chat activity hides the thread-scoped activity dock, closes only
thread-scoped Activity panels, unmounts their consumers, and releases their
client activity state. A terminal-scoped Activity panel may remain open when
AI Terminal activity is enabled.

Turning off AI Terminal activity hides provider-terminal activity docks,
closes only terminal-scoped Activity panels, unmounts their consumers, and
releases their client activity state. Thread-scoped Chat activity remains
available when enabled.

If a settings update fails, the existing settings error and reconciliation
behavior restores the server-authoritative switch and matching UI state.

## Persisted Settings and Migration

Replace the public shared setting with two booleans:

```text
enableChatAgentActivity: boolean       // default true
enableTerminalAgentActivity: boolean   // default false
```

The TypeScript contracts, Rust settings domain, native JSON validation,
defaults, persistence, patch application, and settings update publication must
agree on both fields.

Older settings documents may contain `enableAgentActivity`. During decoding or
normalization:

1. An explicit new setting always wins.
2. If `enableChatAgentActivity` is absent, it inherits the legacy
   `enableAgentActivity` value; if both are absent, it defaults to `true`.
3. If `enableTerminalAgentActivity` is absent, it defaults to `false`
   regardless of the legacy value.
4. The legacy key is not exposed in the current settings contract and is
   removed when the normalized document is next persisted.

This preserves a user's prior choice for Chat while ensuring AI Terminal
activity is disabled after upgrade as well as on fresh environments.

## Architecture

### Source-specific gates

Keep the existing bounded `AgentActivityController` lifecycle semantics, but
own one controller for thread-scoped Chat activity and one for terminal-scoped
activity. Each controller has its own enabled state, observation generation,
in-flight admissions, stream registrations, drain, and state notifications.

The activity source is derived from `ActivityScopeRef`:

- `thread` selects the Chat controller;
- `terminal` selects the AI Terminal controller.

The controllers never fall back to a combined master switch. A transition of
one controller cannot advance the other controller's generation, close its
streams, or reject its work.

### Projection and repository

Use source-bound projections over the existing shared activity repository.
The provider chat runtime receives the Chat projection, while the
provider-terminal supervisor receives the AI Terminal projection. Thread and
terminal logical scopes are already disjoint in `ActivityScopeRef`, so each
source retains a separate admission gate and event stream without changing the
stored activity model.

Repository cleanup and monitoring-disabled finalization become source-aware:

- disabling Chat interrupts unresolved records only in thread scopes;
- disabling AI Terminal interrupts unresolved records only in terminal
  scopes.

History for both source types remains in the shared repository. Retention and
publication state belonging to the still-enabled source must not be cleared by
the other source's transition.

### RPC routing

Activity snapshot, roster, detail, and subscription RPCs route to the
controller and projection selected by the request's `ActivityScopeRef`.

When one source is disabled:

- new requests for that source fail with the existing structured
  `featureDisabled` error before repository access;
- active streams for that source close;
- racing responses are fenced by that source's observation generation; and
- requests and streams for the other source continue normally.

Authorization and protocol-version behavior remain unchanged.

### Chat runtime boundary

Structured provider runtimes use only the Chat controller and projection.
Disabling Chat activity closes Chat admission, finalizes active thread records,
and stops activity-specific provider adapter work. Provider conversations and
their required protocol parsing continue normally.

Re-enabling Chat activity resumes supported live provider observation from a
new Chat observation generation. Events from the disabled interval are not
backfilled.

### AI Terminal boundary

The provider-terminal supervisor and terminal manager use only the AI Terminal
controller and projection. With the setting disabled at startup or launch,
provider terminals pass through without capability probing, helper startup,
hook generation, executable pinning, or observer preparation.

Disabling AI Terminal activity for a live instrumented terminal immediately
stops activity parsing, publication, projection, and storage. Transport needed
to keep the terminal functional may remain dormant under the existing bounded
restart-descriptor rules. Re-enabling attempts to resume eligible terminals
that were previously instrumented. A terminal launched while disabled must be
reopened before it can expose activity.

Chat runtime observation is unaffected by every AI Terminal transition.

### Transition coordination and traces

Settings updates remain persist-first. After persistence, only changed source
settings invoke lifecycle transitions, and the updated settings are published
after the transition attempt according to the existing ordering guarantees.

Transition diagnostics include the source (`chat` or `terminal`) alongside the
requested and effective state. Provider observer counts apply to Chat
transitions, while terminal observer and epoch counts apply to AI Terminal
transitions. No per-event logging or sensitive provider data is added.

## Failure and Concurrency Semantics

- Concurrent Chat and AI Terminal setting updates serialize through the
  settings update lock but transition only their changed source.
- Each source retains its own lifecycle lock and generation fence.
- A failure transitioning one source is bounded and reported without changing
  the other source's effective state.
- Persist failures do not invoke either transition.
- Closing one admission gate does not wait for in-flight operations admitted
  by the other gate.
- Terminal transition failures do not terminate the terminal process.
- Cleanup errors do not silently reopen the disabled source.

## Testing

### Contracts and settings

- Assert fresh defaults: Chat enabled and AI Terminal disabled.
- Decode and patch both booleans independently; reject non-booleans.
- Cover the legacy migration matrix for missing and explicit new fields.
- Verify Rust domain persistence and reload for every combination.
- Verify native validation, normalization, atomic persistence, publication,
  and persist-before-transition ordering.

### Backend activity

- Exercise both controllers independently, including simultaneous transitions.
- Prove Chat disablement rejects only thread admission, reads, and streams.
- Prove AI Terminal disablement rejects only terminal admission, reads, and
  streams.
- Verify source-specific unresolved-record finalization and retained history.
- Verify provider runtime observers respond only to Chat transitions.
- Verify terminal observers, dormant transports, and new launch preparation
  respond only to AI Terminal transitions.
- Cover all four setting combinations at startup and during live transitions.

### Web UI

- Render both rows, descriptions, switches, reset controls, and Experimental
  badges.
- Assert Chat is checked and AI Terminal is unchecked by default.
- Assert each switch emits only its matching settings patch.
- Assert reset actions use their respective shared defaults.
- Verify Chat disablement removes only thread activity UI and state.
- Verify AI Terminal disablement removes only terminal activity UI and state.
- Verify terminal-scoped right-panel activity remains usable when Chat is off,
  and the inverse for thread-scoped activity.

### Verification

- Run focused TypeScript and Rust tests for settings, activity RPC/projection,
  provider runtimes, terminal supervision, and affected React components.
- Run `vp check`.
- Run `vp run typecheck`.

## Acceptance Criteria

1. Settings → Agents shows separate Chat and AI Terminal activity switches.
2. Both settings rows display an Experimental badge.
3. Chat activity defaults on; AI Terminal activity defaults off.
4. The two settings are persisted per environment and operate independently.
5. Existing settings preserve the prior Chat choice and migrate AI Terminal to
   off.
6. Disabling one source immediately removes only its activity UI and closes
   only its RPC consumers.
7. The disabled source performs no new optional activity observation,
   projection, publication, persistence, or repository reads.
8. The enabled source continues operating during and after the other source's
   transition.
9. Chats and terminal processes continue functioning regardless of activity
   settings.
10. Existing history is retained and disabled-period activity is not
    backfilled.
11. Required repository checks and focused tests pass.
