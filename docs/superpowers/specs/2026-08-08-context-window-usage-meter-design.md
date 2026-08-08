# Context Window Usage Meter Design

**Date:** 2026-08-08
**Status:** Approved

## Summary

Add a context-window usage control to BiBCode's normal chat-composer toolbar,
matching the supplied T3Code Alpha interaction: a compact circular usage meter
opens a popover with the current context, maximum context, percentage, total
processed tokens when known, and automatic-compaction guidance.

The control is always present in the normal composer footer and is ordered
between MCP status and the primary send/stop action. Provider inventory
capabilities determine whether the control is available. Codex and Claude are
enabled initially; Cursor, Grok, and OpenCode show the same control in a muted,
disabled state because BiBCode cannot currently retrieve trustworthy context
usage from those providers.

This design supersedes the context-usage visibility and ordering described in
`docs/superpowers/specs/2026-07-31-chat-composer-toolbar-design.md`. It does not
otherwise alter that toolbar design.

## Reference Implementation Findings

The T3Code implementation was traced across provider adapters, contracts,
server ingestion, client retention, derivation, and presentation rather than
copying only its visual component:

- `packages/contracts/src/providerRuntime.ts` owns the typed token snapshot.
- Codex normalizes `thread/tokenUsage/updated`; its `last.totalTokens` is the
  active context and `total.totalTokens` is lifetime processed usage.
- Claude combines streamed usage with a completion-time context query. It does
  not treat accumulated result usage as active context.
- `context-window.updated` is projected as durable thread activity.
- The client keeps the latest valid context update for each turn, so malformed
  and duplicate updates cannot displace reliable state or break revert
  semantics.
- `ContextWindowMeter` and the pure `contextWindow` helper own presentation and
  derivation respectively.

T3Code's first implementation landed in March 2026 and was followed by fixes
for ring presentation, hover behavior, and especially Codex/Claude usage
semantics. BiBCode already contains the dormant contract, derivation helper,
meter component, and composer integration imported by its earlier toolbar
work, but its native providers do not emit the usage event and the meter is
currently omitted when no sample exists. The backend and state lifecycle are
therefore part of this feature, not optional follow-up work.

## Goals

- Always render the context-window control in the normal chat toolbar.
- Place it after MCP status and immediately before send/stop.
- Enable it only when the selected provider instance advertises trustworthy
  context usage.
- Support Codex and Claude without estimating tokens from rendered messages.
- Distinguish active context from lifetime processed tokens.
- Retain the latest valid value through duplicate events, reconnects, process
  restarts, compaction, and checkpoint reverts.
- Keep provider-native protocol details in their owning Rust adapters.
- Keep contracts schema-only, lifecycle policy in server/client state owners,
  and presentation in the web application.
- Keep the hot path bounded in memory and in the durable activity projection.

## Non-goals

- Estimating context usage from transcript text, character counts, tokenizer
  guesses, model names, or UI-visible messages.
- Enabling Cursor, Grok, or OpenCode until their actual runtime path reports a
  verified current-context value and maximum.
- Adding token billing, pricing, quotas, or provider-account usage.
- Displaying category breakdowns that a provider did not report.
- Changing provider selection, model selection, MCP configuration, compaction
  policy, or provider authentication.
- Persisting a second context-usage cache outside the orchestration activity
  projection.
- Importing code from T3Code or from `.repos/`.

## Provider Capability Contract

Add the optional boolean `supportsContextWindowUsage` to `ServerProvider`.
Absence means unsupported for backward compatibility. The server inventory is
the source of truth:

| Driver | Capability | Initial behavior |
| --- | --- | --- |
| Codex | `true` | Enabled; native token-usage notifications |
| Claude | `true` | Enabled; native control query plus stream fallback |
| Cursor | absent/false | Always visible, disabled |
| Grok | absent/false | Always visible, disabled |
| OpenCode | absent/false | Always visible, disabled |

Capability is resolved for the exact selected provider instance. The UI must
not infer support from a display name, model slug, executable presence, or
whether a stale activity happens to exist.

No database migration is required because provider inventory is a live server
snapshot and the field is optional in the TypeScript schema.

## Normalized Usage Contract

Continue using the existing `ThreadTokenUsageSnapshot` contract and canonical
provider event:

```text
thread.token-usage.updated
  payload.usage.usedTokens                 required, non-negative
  payload.usage.totalProcessedTokens       optional, non-negative
  payload.usage.maxTokens                  optional, positive
  payload.usage.inputTokens                optional, non-negative
  payload.usage.cachedInputTokens          optional, non-negative
  payload.usage.outputTokens               optional, non-negative
  payload.usage.reasoningOutputTokens      optional, non-negative
  payload.usage.last*                      optional, non-negative
  payload.usage.toolUses                   optional, non-negative
  payload.usage.durationMs                 optional, non-negative
  payload.usage.compactsAutomatically      optional boolean
```

`usedTokens` always means the provider's best native measurement of the
currently active context. It never means the sum of every request in the
thread. `totalProcessedTokens` is the accumulated/lifetime figure when the
provider reports one. Optional category fields remain optional and are not
reconstructed from other totals.

The orchestration projection unwraps `payload.usage` into the existing
`context-window.updated` activity payload. This matches the dormant web
derivation contract and avoids exposing provider envelopes to the UI.

## Codex Normalization

The Codex adapter handles App Server's `thread/tokenUsage/updated`
notification after its existing root-thread/child-thread filter.

For a valid notification:

- `tokenUsage.last.totalTokens` becomes `usedTokens`.
- `tokenUsage.total.totalTokens` becomes `totalProcessedTokens`.
- `modelContextWindow`, when positive, becomes `maxTokens`.
- Matching `last` and `total` category fields populate the corresponding
  normalized fields when present.
- `compactsAutomatically` is `true` because Codex App Server owns automatic
  context compaction.
- Native `threadId` and `turnId` are preserved on the canonical event.

Notifications for child threads remain ignored, just like other child-agent
content. Missing, nonnumeric, non-positive, or otherwise invalid current usage
is ignored. Optional malformed fields are omitted rather than invalidating an
otherwise valid current sample.

## Claude Normalization

Claude's stream-json result usage is not assumed to be active-context usage.
The Claude adapter maintains bounded per-session state containing only the
last valid active usage, last valid maximum, accumulated total, and known
compaction setting.

### Stream fallback

Recognize usage from native stream-json frames that carry it, including
message-delta usage, task progress/notification usage, compact boundaries, and
result/model-usage summaries. Stream frames update the last-good state under
these rules:

- iteration/current usage may update `usedTokens`;
- accumulated result usage may update `totalProcessedTokens` but does not
  overwrite a reliable active-context value;
- a native model context window may update `maxTokens` when positive;
- a compact boundary resets or replaces the pre-compaction active sample only
  when the boundary supplies a valid post-compaction value;
- used context is clamped to a known positive maximum for display safety;
- malformed or missing fields never clear last-good data.

### Authoritative completion query

At successful turn completion, the driver sends Claude's native
`get_context_usage` control request through the existing stream-json stdin.
The stdout pump routes the matching `control_response` by request ID instead
of forwarding it as a chat event. The query result updates current tokens,
maximum tokens, and automatic-compaction state when those values are valid.

The query is cancellation-aware and has a short bounded timeout. Unsupported
CLI versions, a rejected response, malformed data, process exit, cancellation,
or timeout must not block turn completion and must not fail an otherwise
successful turn. In those cases the driver emits the last valid stream-derived
snapshot if one exists. Query failures are diagnostic metadata only and do not
surface as provider-error activities.

The runtime emits a normalized usage event before the final successful
`turn.completed` event when the completion query yields a newer snapshot. It
does not emit a duplicate when the normalized result is unchanged.

## Projection and Retention

`project_provider_event` maps `thread.token-usage.updated` to an `info`-tone
`context-window.updated` thread activity. It validates and unwraps the usage
payload before dispatching `ThreadActivityAppend`; malformed usage events are
not projected as generic provider tool activities.

The event log remains append-only. The derived activity projection and the
live client thread reducer enforce the same bounded rule:

1. A valid incoming context activity supersedes earlier valid context
   activities for the same thread and turn.
2. Context activities from other turns remain untouched.
3. An invalid incoming activity cannot supersede a valid activity.
4. Exact duplicate delivery produces one effective current sample.
5. Reverting turns removes their context activities through the existing
   turn-scoped revert behavior, revealing the latest surviving earlier-turn
   sample.

Validity requires a finite, non-negative `usedTokens`; `maxTokens`, when
present, must be finite and positive. Optional invalid values are ignored by
normalization/derivation rather than becoming fabricated zeroes.

The SQL activity projector performs same-thread/same-turn valid-context
replacement within the event transaction before inserting the new row. The
client reducer mirrors that logic before sorting activities. Consequently,
streaming many usage updates in one turn does not make snapshot or client state
grow with the number of native usage notifications. The append-only event log
continues to provide audit and rebuild input.

## UI and Interaction

The normal composer footer order becomes:

```text
[attachment] ... [MCP] [context window] [send / stop]
```

The context component receives two independent inputs: provider capability
and the latest valid snapshot. It renders one of three states.

### Unsupported

- Render the ring in a muted disabled treatment.
- Expose `aria-disabled="true"` and the accessible name `Context window usage
  unavailable`.
- Do not open the usage popover or dispatch an action.
- Keep an accessible tooltip explaining that the selected provider does not
  report context usage.

A wrapper may own the tooltip so disabled semantics do not prevent hover or
keyboard explanation. The control remains visible and occupies the same
toolbar position.

### Supported, awaiting first sample

- Render a neutral enabled ring with no fabricated progress.
- The accessible name is `Context window usage awaiting data`.
- Opening the popover shows `Context Window` and explains that usage will
  appear after the provider's first response.
- Provider startup, reconnect, or a newly created thread may remain in this
  state until native evidence arrives.

### Measured

- Render the existing proportional circular ring.
- Open on click or intentional hover using the existing popover primitive.
- Show percentage and `used/max` when maximum is known.
- Show the current token count without a percentage when maximum is unknown.
- Show the progress bar only when maximum is known.
- Show total processed tokens only when positive and reported.
- Show automatic-compaction guidance only when the provider reports that
  behavior.
- Preserve the existing warning color above 90 percent.
- Clamp presentation percentages to 0–100 without changing persisted native
  token values.

Provider capability gates presentation before activity data. Switching from a
supported provider instance to an unsupported one immediately disables the
control even if the thread still contains an older usage activity. Thread
binding remains the authority for the snapshot shown; no data crosses thread
or provider-instance boundaries.

"Always visible" applies to the normal composer toolbar across provider and
data states. Approval/question-specific footers that replace the normal MCP
and send controls retain their existing specialized layout.

## State Ownership and Dependency Direction

- `apps/server/src/provider/codex` owns Codex wire parsing and normalization.
- `apps/server/src/provider/claude` owns Claude wire parsing, query routing,
  last-good provider state, timeout, and normalization.
- `apps/server/src/production/provider_inventory.rs` owns capability
  publication.
- `packages/contracts` owns schemas only and gains no runtime policy.
- `apps/server/src/production/provider_runtime.rs` owns canonical-provider to
  orchestration-activity mapping.
- `apps/server/src/orchestration` owns durable projection retention.
- `packages/client-runtime` owns pure live-thread activity retention.
- `apps/web` owns capability selection, pure display derivation, toolbar order,
  accessibility, and popover presentation.

No desktop-only bridge is added. Provider processes remain server-owned, and
normal application traffic continues over the existing typed WebSocket/RPC
and orchestration event paths in both browser and Tauri modes.

## Failure, Concurrency, and Lifecycle Behavior

- Provider usage is observational; failure to obtain it never fails a turn.
- Claude control responses are correlated by request ID. Late or duplicate
  responses cannot satisfy another query.
- Cancellation and process exit settle pending Claude context requests without
  leaking tasks or retaining senders.
- Bounded query timeout prevents provider stdout or orchestration projection
  from stalling indefinitely.
- The independent stdout pump continues draining frames while a caller awaits
  a control response, preventing pipe backpressure deadlock.
- Unknown native event fields are ignored for forward compatibility.
- Native events scoped to another thread, turn, or child agent cannot update
  the active thread's context meter.
- Last-good state prevents partial, malformed, or stale result frames from
  regressing the displayed context.
- Same-turn retention bounds projection and client memory under frequent
  updates.
- Persisted activity snapshots restore the meter after reconnect or restart.
- Provider instance switching gates stale snapshots immediately.

Context values contain no credentials or user content. Diagnostics may include
the provider driver, request outcome category, and timeout, but must not log
raw provider responses, prompts, environment variables, or authentication
material.

## Performance

- Normalization performs constant work per native usage frame.
- Claude retains one bounded state record per running session and at most one
  pending completion-time context query.
- Control-response correlation is keyed by request ID and cleaned on response,
  timeout, cancellation, or process exit.
- Durable and live activity snapshots retain at most one valid context sample
  per turn, independent of the number of native updates in that turn.
- The web derives the current snapshot with the existing reverse activity scan;
  bounded per-turn retention prevents usage-frame volume from dominating it.
- Ring animation remains GPU-friendly and respects reduced-motion settings.

## Testing Strategy

### Contracts and inventory

- Decode providers with absent, true, and false
  `supportsContextWindowUsage` values.
- Prove only Codex and Claude inventory entries advertise the capability.
- Continue accepting legacy provider snapshots with the field absent.

### Codex provider

- Normalize active, total, maximum, and category values from a realistic
  `thread/tokenUsage/updated` fixture.
- Ignore child-thread notifications.
- Ignore invalid current usage while omitting malformed optional fields.
- Preserve native thread and turn scope.

### Claude provider and driver

- Parse each supported usage-bearing frame.
- Keep accumulated result usage separate from active context.
- Handle compaction boundaries and preserve last-good data.
- Route matching and nonmatching control responses correctly.
- Query success updates current/max/compaction values before completion.
- Timeout, rejection, malformed response, cancellation, and process exit fall
  back without failing or indefinitely delaying completion.
- Repeated equal snapshots do not emit duplicate canonical events.

### Orchestration and client runtime

- Project canonical usage as unwrapped `context-window.updated` activity.
- Keep only the latest valid same-turn projected sample.
- Confirm malformed updates do not evict valid samples.
- Confirm updates from different turns coexist and checkpoint revert exposes
  the previous surviving turn.
- Confirm duplicate live delivery has one effective sample.

### Web

- Render the context control for every provider.
- Verify unsupported, awaiting, and measured visual/accessibility states.
- Verify exact MCP-before-context-before-send ordering.
- Verify provider capability overrides stale activity data.
- Verify percentage, unknown maximum, total processed, compaction text, and
  over-90-percent warning behavior.
- Keep pure derivation tests for malformed payloads and formatting boundaries.

Focused tests run after each behavior change. Final validation follows
`AGENTS.md`: affected TypeScript/Vite+ tests, affected Rust tests,
`cargo fmt --all --check`, Clippy for affected Rust targets with warnings
denied, `vp check`, `vp run typecheck`, and broader package/build checks
proportional to the provider-to-web boundary change.

## Documentation Changes

Update living documentation in the implementation patch:

- `docs/architecture/providers.md` for normalization, capability ownership,
  and context-query failure semantics;
- `docs/architecture/rpc-and-orchestration.md` for canonical event projection
  and bounded activity retention;
- `docs/providers/codex.md` for App Server token usage semantics;
- `docs/providers/claude.md` for stream fallback and `get_context_usage`;
- `docs/user/workspace-ui.md` for toolbar order and the three control states.

## Alternatives Rejected

### Claude stream-only support

This is smaller, but Claude result totals can be accumulated across requests
and may not identify the current post-compaction context or automatic
compaction setting. It remains the fallback, not the primary completion sample.

### Frontend estimation

Counting rendered text or applying a model tokenizer cannot account for system
instructions, tools, cached inputs, reasoning, provider-side prompt shaping,
or compaction. It would display precise-looking but false information.

### Codex-only first release

This lowers initial backend work but does not satisfy the approved initial
support matrix and would leave a native Claude capability unused.

### Hide unsupported providers

The user explicitly requires a stable, always-visible toolbar affordance. A
disabled state also communicates the capability boundary more clearly than a
control that moves or disappears when providers change.

### Store only in web state

Ephemeral UI state would be lost on reconnect/restart and would create a second
source of truth outside orchestration. Durable activity projection already
provides the correct lifecycle boundary.

## Acceptance Criteria

1. The normal composer always renders one context-window control after MCP and
   immediately before send/stop.
2. Codex and Claude provider instances enable the control; Cursor, Grok, and
   OpenCode render it disabled.
3. Supported providers with no sample show an honest awaiting state rather
   than hiding the control or displaying zero usage.
4. Codex active context, lifetime total, maximum, and compaction semantics come
   from native App Server token-usage notifications.
5. Claude uses a bounded native context query at completion and trustworthy
   stream data as fallback; accumulated totals never masquerade as active
   context.
6. Valid usage becomes durable `context-window.updated` activity, survives
   reconnect/restart, and respects checkpoint revert.
7. Duplicate and frequent same-turn updates remain bounded; malformed updates
   do not evict the last valid sample.
8. Provider switching cannot show a supported or stale state for an
   unsupported selected instance.
9. Query or usage failures never fail a turn, leak pending work, deadlock
   provider I/O, or expose sensitive response content in logs.
10. Focused and repository-required validation passes, and living provider,
    orchestration, and workspace documentation reflects the implemented
    behavior.
