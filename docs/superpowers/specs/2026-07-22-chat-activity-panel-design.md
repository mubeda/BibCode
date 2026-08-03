# Chat Activity Dock and Agent Inspector Design

**Date:** 2026-07-22

**Status:** Approved design, pending implementation plan

## Summary

Add a compact, top-right activity dock to T4Code AI chat surfaces. The dock
summarizes subagents and provider-managed background tasks for the current chat.
It expands into a small anchored summary and opens T4Code's existing right-panel
system for a roster or an individual activity timeline.

The feature is backed by a canonical server-side activity graph. Provider
adapters translate native child-agent, tool, process, and lifecycle signals into
shared actors, work items, and activity entries. The web application renders
only capabilities and records the provider can prove. It never infers a
subagent roster from generic tool calls.

T4Code-owned provider terminals may use the same experience when the CLI can be
started against an observable provider harness and a startup handshake proves
that the observer and TUI share one session. The first release targets Codex,
Claude, and OpenCode terminals. Cursor and Grok terminal tabs do not show an
activity dock until their integration exposes stable child lineage and
attributed activity.

The first release is current-chat scoped and inspect-only. It does not aggregate
the workspace or expose stop, steer, resume, terminate, or send-input controls.

## Problem

The latest Codex application makes concurrent work legible through a compact
Subagents summary, an Active/Done roster, and an individual agent view showing
commentary and commands. T4Code currently flattens the provider event stream
into the conversation work log. It has no durable representation of:

- parent/child agent relationships;
- lifecycle state for each child;
- activity attributed to a particular child;
- provider-managed background processes; or
- reconcilable activity for a provider TUI running in a center terminal.

Some existing contracts contain task-shaped events and a
`collab_agent_tool_call` item type, but they do not form a roster. The web
session logic treats progress as flat conversation content, provider adapters
do not consistently emit task events, and OpenCode currently discards child
session events whose session ID differs from the parent.

Building the UI directly from those flat records would produce provider-specific
guessing, fragile reconnect behavior, and inconsistent terminal support.

## Research Conclusion

Subagent observability is a property of the **agent harness**, not the language
model. A model name alone cannot promise a roster. T4Code must negotiate and
test the provider adapter's observable capabilities for the exact installed CLI
or SDK version.

The researched harnesses fall into three groups:

1. **Structured child-session APIs:** Codex App Server and OpenCode expose child
   sessions/threads, status, history, and live events.
2. **Attributed hook and transcript APIs:** Claude exposes subagent lifecycle
   hooks, agent attribution, and transcript helpers.
3. **Foreground event streams without stable child lineage:** the Cursor and
   Grok integrations available to T4Code through CLI/ACP can expose text and
   tool progress, but not enough stable lineage to build a truthful roster.

The provider matrix in this design describes harness capability, not a blanket
claim about every version. A runtime adapter must downgrade or disable a
capability when negotiation or its health handshake fails.

## Goals

- Match the successful Codex interaction model: collapsed summary, expanded
  summary, Active/Done roster, and individual agent detail.
- Keep the dock unobtrusive and compatible with the existing right panel and
  responsive sheet.
- Represent subagents and background work consistently across providers without
  hiding provider-specific detail.
- Reconstruct a correct view after reconnects, restarts, duplicate events, and
  late events whenever the harness retains authoritative history.
- Support observable T4Code-owned Codex, Claude, and OpenCode provider terminals.
- Preserve T4Code's performance and reliability under high event volume.
- Make unsupported behavior absent rather than misleading.

## Non-goals

- Workspace-wide or project-wide activity aggregation.
- Showing agents from unrelated chats or independent provider sessions.
- Controls that mutate agents or processes, including stop, steer, resume,
  terminate, retry, or send input.
- Inferring child agents from tool names, prompt text, icons, or command output.
- Observing arbitrary terminals that T4Code did not launch with an activity
  observer.
- Replacing the normal conversation work log.
- Standardizing providers' internal prompts, roles, reasoning, or orchestration
  strategies.
- Displaying hidden chain-of-thought. Only provider-delivered user-visible
  commentary, summaries, tools, commands, results, and errors are eligible.

## Approved Decisions

| Decision | Approved choice |
| --- | --- |
| Scope | Current open chat and its descendants only |
| First-release controls | Inspect-only |
| Terminal providers | Codex, Claude, and OpenCode when reliably observed |
| Cursor/Grok terminals | No activity dock in v1 |
| Architecture | Canonical server-side activity graph |
| Compact layout | Floating top-right dock |
| Detail layout | Existing right-panel surface / responsive sheet |
| Empty state | No permanent dock when there are no supported records |

## Terminology

### Activity scope

One observable root chat or one T4Code-owned provider-terminal session. A chat
scope includes descendants spawned by that root but excludes siblings,
ancestors, and independent sessions in the same workspace.

### Actor

An agent-like participant with a stable provider identity. The root agent may be
retained in the graph for ownership but is not shown in the Subagents roster.
A visible subagent has a relationship to the root through one or more parent
edges.

### Work item

A provider-managed unit of asynchronous work that is not itself a child agent,
such as a background shell process. Work items appear under **Background
tasks** and have an owning actor when the provider supplies that relationship.

### Activity entry

A bounded, time-ordered record attributed to an actor or work item: commentary,
tool use, command, result, error, state transition, or completion summary.

### Native identity

The provider's stable thread, session, agent, tool-use, or process identifier.
The adapter namespaces it by provider instance and activity scope before it
enters the canonical graph.

## User Experience

### Visibility and collapsed dock

The dock appears in the upper-right of the active chat content after the scope
contains at least one supported child actor or background work item. It remains
available after completion so users can inspect history. A scope with no
supported records has no dock.

The collapsed dock shows only compact counts:

- active subagents;
- completed subagents when space permits; and
- active background tasks.

Icons and counts carry accessible labels such as “2 active subagents, 1
background task.” Completion uses status, shape, and text rather than color
alone.

### Expanded summary

Clicking the collapsed dock opens an anchored card with up to two rows:

- **Subagents** — active and done counts;
- **Background tasks** — active and done counts.

A row is rendered only when the adapter supports the section and the scope has
records for it. Clicking a row opens the Activity right-panel surface already
filtered to that section. Opening the right panel collapses the summary card.

Expanded/collapsed preference is stored locally per workspace. The content and
counts are not stored as UI state; they come from the server snapshot.

### Roster

The Activity right-panel surface has a single persistent tab. It changes route
internally rather than opening one tab per agent:

1. Subagents roster;
2. Background Tasks roster; or
3. individual actor/work-item detail.

The roster separates **Active** and **Done**. Active includes starting, running,
waiting, and reconnecting records. Done includes completed, failed, cancelled,
and interrupted records with an explicit terminal-state label.

Each row shows:

- provider icon/accent;
- bounded display name or stable fallback label;
- role/type when supplied;
- current state;
- the newest eligible summary;
- elapsed time while active, or completion age when done; and
- a disclosure affordance for detail.

The full done list is paginated. Active and total counts remain exact even when
only the first page is loaded.

### Individual detail

Detail preserves the roster's route and back navigation. It shows:

- name, provider, role/type, state, and elapsed duration;
- parent relationship when helpful;
- user-visible commentary and completion summary;
- tools and commands in collapsible groups;
- bounded results or links back to the corresponding conversation event; and
- explicit errors, interruptions, and loss-of-observation markers.

The view does not synthesize prose describing what an agent “must be doing.” If
the provider supplies only a state transition, the UI displays that state and
the last known timestamp.

### Responsive behavior

- At wide desktop widths, the dock shows icons and counts and the inspector uses
  the existing right-panel column.
- Between approximately 800 and 1200 CSS pixels, the dock reduces to
  icon-and-count presentation.
- Below T4Code's existing 980-pixel right-panel breakpoint, roster and detail
  use the existing sheet behavior.
- The dock is anchored within the chat/terminal content boundary and never
  covers the composer, terminal toolbar, or native window controls.
- Chat content and the activity inspector scroll independently.

### Keyboard and accessibility

- The dock and each row are real buttons with visible focus styling.
- `Escape` closes the expanded summary before affecting the surrounding panel.
- Roster/detail navigation follows the existing right-panel focus and sheet
  conventions.
- Live updates do not steal focus. Count changes use a polite, coalesced live
  announcement rather than announcing every activity entry.
- Reduced-motion preferences disable count and state-transition animation.

## Chosen Architecture

### Why a server-side graph

The server already owns provider connections, session persistence, process
supervision, and WebSocket reconnection. A server-side projection gives every
client one provider-neutral lifecycle, prevents the browser from reverse
engineering raw streams, and makes terminal and structured-chat observation
shareable.

Two rejected alternatives were:

- **Client-derived roster:** initially smaller, but loses state when the panel
  is closed or the browser reconnects and duplicates provider parsing in UI
  code.
- **Separate provider panels:** exposes maximum native detail quickly, but
  duplicates UX, error handling, retention, and tests and makes new providers
  expensive to add.

### Layering

```text
Native provider APIs, hooks, SSE, and process signals
                         │
                         ▼
Provider activity adapters
(native identity + normalized records + bounded metadata)
                         │
                         ▼
Server activity graph projection
(scope, relationships, state machine, snapshot, ordered deltas)
                         │
                         ▼
Web activity cache
(summary counts, paginated rosters, lazy detail)
                         │
                         ▼
Floating dock ── Activity right panel / responsive sheet
```

Provider parsing remains in `apps/server`. Shared wire schemas remain in
`packages/contracts`, with no runtime projection logic added there. Generic
projection helpers that are genuinely shared between server runtimes may live
in `packages/shared` through an explicit subpath export.

### Capability contract

Each activity scope publishes adapter capabilities alongside its snapshot:

```ts
interface ActivityCapabilities {
  readonly actors: boolean;
  readonly attributedActivity: boolean;
  readonly backgroundWork: boolean;
  readonly historyRecovery: "full" | "bounded" | "none";
  readonly terminalObservation: boolean;
}
```

These are runtime facts for the exact adapter session, not static provider-name
checks in React. The server enforces invariants, including:

- `attributedActivity` requires stable actor/work-item identities;
- `terminalObservation` remains false until the observer handshake succeeds;
- a failed health check can downgrade a capability without deleting already
  observed history; and
- unknown provider fields cannot add capabilities implicitly.

### Canonical graph

The logical graph contains four record families.

#### Scope

- canonical scope ID;
- host thread ID or center-terminal ID;
- provider instance and driver identity;
- negotiated capabilities;
- connection/recovery state;
- current revision; and
- created/updated timestamps.

#### Actor

- canonical actor ID and native identity;
- optional canonical parent actor ID;
- root/subagent kind;
- bounded name, nickname, role, and provider type;
- lifecycle state;
- start, update, and terminal timestamps;
- last visible summary reference; and
- bounded provider metadata.

#### Work item

- canonical work-item ID and native identity;
- kind such as background process or delegated task;
- optional owning actor ID;
- bounded label, command summary, and working directory display value;
- lifecycle state;
- optional provider process identity and metrics;
- timestamps; and
- bounded provider metadata.

#### Activity entry

- canonical entry ID and native identity when supplied;
- owning actor or work-item ID;
- entry kind;
- timestamp and source ordering key;
- bounded summary and structured display payload;
- optional link to an existing conversation item; and
- bounded provider metadata.

The graph is not a replacement conversation transcript. When activity already
exists as a normal conversation item, the activity entry references it and
stores only the fields needed for attribution and summary.

### Lifecycle state

The canonical lifecycle is:

```text
starting → running ↔ waiting → completed
                         ├──→ failed
                         ├──→ cancelled
                         └──→ interrupted
```

`unknown` is allowed for a newly discovered historical record whose provider
state cannot yet be mapped. `reconnecting` is a scope observation state, not a
claim that the provider actor changed state.

Terminal states never regress because of a late non-terminal event. An adapter
may correct one terminal state to another only through a newer authoritative
snapshot and must retain a diagnostic explaining the correction.

## Snapshot and Delta Protocol

Opening or restoring a scope requests an `ActivitySnapshot` containing:

- scope identity and capabilities;
- graph revision;
- exact summary counts;
- all currently active actor/work-item summaries within the bounded active
  payload policy;
- the newest completed summaries needed for initial rendering; and
- pagination cursors for the remaining roster/history.

After the snapshot, the client applies ordered `ActivityDelta` notifications.
Every delta contains the scope ID, previous revision, next revision, and one or
more idempotent upserts/removals. A revision gap marks the cache stale and
triggers snapshot reconciliation; the client does not guess missing changes.

Provider adapters deduplicate by namespaced native event identity when
available. When a provider does not supply one, the ingestion connection assigns
a monotonic source sequence and persists it with the normalized event before
publication.

The client cache is keyed by environment and activity scope so similarly named
provider sessions cannot collide. Scope changes unsubscribe the prior live view
without deleting its cached, completed history.

## Persistence and Recovery

### Structured chats

Normalized activity events participate in the server-owned session event log.
The activity graph is a materialized projection that can be rebuilt from that
log and reconciled with provider history.

On reconnect:

1. the web client marks its last snapshot stale but keeps it visible;
2. it requests a fresh snapshot rather than replaying from an assumed revision;
3. the server asks the provider adapter to reconcile authoritative descendants,
   state, and missing history where supported;
4. the projector publishes the new revision; and
5. the client replaces stale state atomically, then resumes deltas.

If authoritative history is unavailable, observed completed records remain and
formerly active records become `interrupted`. They do not become `completed`.

### Provider terminals

Only provider terminals created through T4Code's provider-terminal action are
eligible. Their normalized events use a bounded server-side observation journal
associated with the center-terminal ID and native provider session ID.

If the T4Code server restarts and cannot reattach to the same live harness, the
existing journal remains inspectable and active records become `interrupted`.
Starting a new CLI process creates a new activity scope even if it uses the same
center-panel tab.

## Provider Adapter Design

### Fidelity matrix

| Harness | Structured chat | T4Code-owned terminal | Primary signals |
| --- | --- | --- | --- |
| Codex App Server | Full when experimental API negotiation succeeds | Full after shared-session handshake | descendant threads, collaboration items, status, history, background terminals |
| Claude Agent SDK/CLI | Full after hook-event adapter upgrade | Full after hook/registry handshake | SubagentStart/Stop, `agent_id`, tool hooks, transcript helpers |
| OpenCode server/SDK | Full | Full after shared-server handshake | child sessions, status, messages, SSE |
| Cursor CLI/ACP | Only genuine records exposed by the active protocol | No dock in v1 | foreground messages/tool events; no stable child lineage in researched interface |
| Grok CLI/ACP | Only genuine records exposed by the active protocol | No dock in v1 | foreground messages/tool events; no stable child lineage in researched interface |

“Full” means the harness can supply actor lineage, attributed activity, status,
and recovery needed by this design. Individual sections such as Background
Tasks still render only when the session actually has records and the adapter
negotiates that section.

### Codex App Server

The Codex adapter initializes with the experimental API capability and maps:

- `thread/list` descendant filters and `parentThreadId` into actor edges;
- thread status notifications into actor lifecycle;
- collaboration and subagent activity thread items into actor/activity records;
- `thread/read`, thread/item pagination, and persisted turns into recovery;
- background-terminal listing into work items; and
- provider-native IDs into stable canonical identities.

The inspected Codex 0.145.0 schema also exposes collaboration calls with sender
and receiver thread IDs, agent states, tool kind, and lifecycle status. T4Code
must generate or validate bindings against the installed App Server version
rather than copying one release's experimental schema permanently.

For a T4Code-owned Codex terminal, T4Code starts a dedicated local App Server
control endpoint, attaches the observer, and launches the Codex TUI with
`--remote` against that same endpoint. The installed CLI accepts WebSocket and
Unix-socket endpoints; the Unix-socket control transport is preferred because
the App Server documentation labels its ordinary WebSocket listener
experimental and unsupported. The activity dock appears only after the TUI's
native thread/session is correlated with an observed App Server thread.

The first release reads background terminals but does not call clean or
terminate endpoints.

### Claude Agent SDK and CLI

The existing structured Claude process is upgraded to request hook lifecycle
events and subagent text attribution. The adapter maps:

- `SubagentStart` and `SubagentStop` hooks into actor lifecycle;
- stable `agent_id`/agent type fields into identity and role;
- attributed pre/post tool hooks into activity entries; and
- transcript helpers or controlled transcript reads into history/detail.

The installed Claude CLI exposes `--include-hook-events`,
`--forward-subagent-text`, background-agent commands, session IDs, and settings
injection. The adapter must feature-detect these switches and validate incoming
hook shapes because the surface is versioned independently of T4Code.

For a T4Code-owned interactive Claude terminal, the launcher installs a
T4Code-managed additional hook sink through an isolated settings overlay and a
per-launch correlation token. It must preserve the user's normal Claude
configuration and hooks. The observer reconciles against Claude's background
agent registry/transcript helpers where available. No dock appears until the
hook sink receives a valid session handshake. If a future CLI version cannot
compose the overlay safely, terminal observation is downgraded to unsupported
and Claude launches normally.

### OpenCode server and SDK

The OpenCode adapter stops discarding SSE events solely because their session
ID differs from the root. Instead, it verifies the project/server scope and
uses the child-session relationship before admitting them into the graph.

It combines:

- child-session enumeration for actor edges;
- session status for lifecycle;
- session messages for detail and recovery; and
- server SSE for live deltas.

For a T4Code-owned OpenCode terminal, T4Code starts one loopback server with a
per-launch credential, connects the observer, and launches the TUI with
`opencode attach` to that exact endpoint. The endpoint is not exposed on a
non-loopback interface by default. The dock appears only after the attached TUI
and observer report the same native session.

### Cursor and Grok

The existing Cursor and Grok T4Code integrations use event streams/ACP that can
represent foreground messages and tool calls but do not currently provide the
stable child identity, parent edge, attributed history, and lifecycle required
for a roster.

Structured chat may show a section in the future if a newer negotiated protocol
delivers genuine records satisfying the canonical invariants. Generic ACP tool
calls do not qualify. Their provider-terminal tabs show no dock in v1.

Cursor's separate cloud Background Agents API is a different product surface
with remote-agent lifecycle. It is not silently mixed into the current local
chat scope; adding it requires its own scope and authentication design.

### Unknown and custom providers

Custom providers start with all activity capabilities disabled. A provider can
adopt the UI by implementing the server adapter contract and its fixture suite.
React never enables features from display names or driver aliases.

## Background Tasks Semantics

**Background tasks** contains asynchronous provider work that has an
independent lifecycle and stable native identity but is not represented as a
child actor. Examples include a Codex background terminal or a long-running
provider process explicitly reported by the harness.

Ordinary foreground tool calls and short shell commands remain activity entries
under their actor. They do not become Background Tasks merely because they run
for a long time. This distinction prevents duplicate rows between the roster
and detail timeline.

When a provider reports both an actor and a background work item, the work item
links to its owning actor. Ending the actor does not automatically mark the work
item complete unless the provider lifecycle or process observer proves it.

## Performance and Retention

- Summary counts are computed by the server projection; the browser does not
  scan full histories.
- Initial snapshots contain summaries, not transcripts or command output.
- Roster and detail endpoints are cursor-paginated. Default and maximum page
  sizes are bounded constants covered by contract tests.
- Detail rows and command output use virtualized rendering and the existing
  bounded event-payload conventions where applicable.
- Completed graph summaries have a configurable per-scope memory cap. Provider
  or session history remains authoritative and can repopulate older pages.
- Active records are never silently omitted from counts. When an extreme active
  set exceeds the initial payload bound, the snapshot includes exact counts and
  a cursor/banner indicating more active rows.
- Closed panels consume the existing normalized event stream but initiate no
  detail-history polling.
- Background process metrics refresh only while their section or detail is
  visible and the provider supplies metrics.
- Provider metadata is schema-bounded, field-count bounded, and size-limited
  before persistence or broadcast.
- Projection updates are batched per event-loop tick so a burst does not render
  one React update per native event.

## Error and Exceptional States

### No supported activity

Render no dock. A permanently empty placeholder would imply support and consume
chat space without helping the user.

### Reconnecting

Keep the last snapshot visible with a quiet stale/reconnecting indicator.
Disable no unrelated chat behavior. On successful reconciliation, replace the
snapshot atomically.

### Revision gap or projection failure

Mark only the affected scope stale and request a new snapshot. Repeated failure
shows a bounded retry affordance in the affected section and records a server
diagnostic. Other chat and right-panel surfaces remain usable.

### Partial provider failure

Capabilities can degrade independently. For example, actor history can remain
available while background-terminal metrics fail. Preserve already observed
records and label only the affected section stale.

### Lost actor or process

If recovery cannot prove completion, use `interrupted` with the last observed
timestamp. Never convert loss of observation into success.

### Unsupported or incompatible version

Log a bounded diagnostic with provider version and failed capability. Continue
the provider chat/terminal without the affected dock section. Do not block the
underlying conversation merely because its inspector is unavailable.

### Malformed or oversized provider data

Reject the field or record at the adapter boundary, preserve stream health, and
emit a rate-limited diagnostic. Never render provider-delivered HTML or
unbounded structured metadata directly.

## Security and Privacy

- Activity RPCs use the same authenticated environment, project, and
  chat/session authorization boundaries as the underlying conversation.
- The server validates that requested descendants belong to the root scope.
- Terminal correlation tokens are random, per launch, short-lived, and never
  displayed in labels or logs.
- Local observer endpoints prefer Unix sockets or authenticated loopback
  listeners with restrictive lifecycle and filesystem permissions.
- Command arguments and output follow the same redaction and safe rendering
  policy as corresponding conversation tool events.
- Secrets, tokens, full environment blocks, and raw provider configuration are
  excluded from searchable summaries and provider metadata.
- No activity payload can execute HTML, terminal escapes, or shell text.
- Inspect-only UI means no process-control RPC is added for this feature even
  where a provider exposes one.
- User-visible commentary is distinct from hidden reasoning. Hidden
  chain-of-thought is neither requested nor reconstructed.

## Web State and Panel Integration

The Activity inspector is a new kind in the existing thread-scoped right-panel
store. Its persisted UI state contains only:

- open/closed state;
- section filter;
- selected canonical actor/work-item ID when still valid; and
- local expanded/collapsed preference.

It does not persist provider payloads. On hydration, invalid selected IDs fall
back to the relevant roster. The current right-panel breakpoint continues to
control sheet behavior.

The dock mounts inside both the normal chat content boundary and eligible
provider center-terminal surfaces through a shared presentation component. The
component consumes one provider-neutral activity view model; it does not import
Codex-, Claude-, or OpenCode-specific event types.

## Testing Strategy

### Contract tests

- Snapshot, delta, capability, roster-page, and detail-page schemas round-trip.
- Bounds reject empty IDs, invalid parent references, excessive metadata,
  oversized labels, and invalid lifecycle values.
- Old clients can ignore new activity notification methods without breaking
  existing provider event decoding.

### Provider fixture tests

Each supported adapter has recorded native fixtures covering:

- child creation, nested child creation, progress, waiting, and completion;
- failed, cancelled, interrupted, and unknown states;
- attributed commentary, tools, commands, and results;
- background work where supported;
- duplicate, late, missing, and malformed events;
- history reconciliation; and
- capability downgrade for an incompatible version.

Codex fixtures cover collaboration thread items, descendant listing, thread
status, and background-terminal records. Claude fixtures extend the existing
Task tool trace with hook events, stable agent attribution, nested subagents,
and transcript recovery. OpenCode fixtures cover parent/child session SSE that
the current adapter filters out.

### Projection tests

- Canonical identity is stable and namespaced by provider instance/scope.
- Parent edges cannot escape the root scope or form visible cycles.
- Deltas are ordered, idempotent, and revision gaps require a snapshot.
- Terminal states do not regress from late progress.
- Authoritative snapshots reconcile corrections predictably.
- Missing active records become interrupted when recovery is impossible.
- Exact counts remain correct with paginated/capped payloads.
- Retention removes only eligible completed summaries and preserves references
  needed by visible pages.

### Web tests

- No records means no dock.
- Collapsed and expanded counts update without stealing focus.
- Each summary row opens the correct Activity section.
- Active/Done sorting and status labels are correct.
- Roster rows drill into detail and back navigation preserves the filter.
- Partial error, stale, interrupted, empty, and capability-downgrade states
  render accurately.
- Unsupported providers and failed terminal handshakes render no misleading
  dock.
- Local workspace preference persists while server-derived content does not.
- Keyboard, accessible names, polite announcements, and reduced-motion behavior
  are covered.
- Geometry is verified at wide desktop, 800–1200-pixel compact mode, and below
  the existing sheet breakpoint.

### Terminal integration tests

- Codex: observer and `codex --remote` TUI correlate to one native thread before
  the dock is enabled.
- Claude: hook overlay preserves normal user settings, validates the correlation
  token, and attributes a subagent event.
- OpenCode: observer and `opencode attach` correlate to one server/session.
- Observer startup failure launches or preserves the provider terminal without
  an activity dock.
- Reattachment does not spawn a second provider process or duplicate history.
- Server loss preserves the bounded journal and marks unresolved activity
  interrupted.

### Repository verification

Run focused tests during implementation, followed by the required:

```sh
vp check
vp run typecheck
```

Use `vp test` for built-in Vite+ suites and `vp run test` only when a package's
`test` script is specifically required.

## Acceptance Criteria

1. A supported chat with child activity shows an unobtrusive top-right dock;
   an unsupported or empty chat does not.
2. The dock accurately separates Subagents and Background Tasks and opens the
   existing right-panel/sheet system.
3. Users can inspect Active/Done rosters and attributed per-record activity
   without hidden-reasoning leakage or inferred state.
4. Counts, terminal states, and relationships remain correct after duplicate
   events, late events, panel close/reopen, and client reconnect.
5. Codex, Claude, and OpenCode structured integrations pass their adapter
   fidelity suites.
6. T4Code-owned terminals show the dock only after a reliable shared-session
   handshake; Cursor and Grok terminals show none in v1.
7. The feature remains inspect-only and current-chat scoped.
8. High event volume is paginated, bounded, and batched without loading full
   transcripts into the initial snapshot.
9. Focused suites, `vp check`, and `vp run typecheck` pass.

## Compatibility and Rollout

The activity protocol is additive. Existing conversation rendering remains the
fallback and must not depend on the activity projector. Provider capabilities
are negotiated per session, allowing adapters to ship incrementally without
provider-name conditionals in the UI.

Implementation should land behind a server-advertised activity protocol
version until all snapshot/delta invariants and at least Codex structured-chat
coverage are complete. Subsequent provider adapters can enable their own
capabilities independently. Terminal capability remains separately gated from
structured-chat capability because a provider may support one without the
other.

## Research Sources

Research was checked on 2026-07-22. Provider surfaces, especially experimental
ones, may change; generated bindings and runtime capability tests are therefore
part of the design.

- OpenAI's [Codex App Server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
  documents rich-client transports, descendant thread filters, status/history,
  ordered notifications, bounded backpressure, and experimental background
  terminal APIs.
- OpenAI's [Codex harness architecture article](https://openai.com/index/unlocking-the-codex-harness/)
  describes App Server as the stable interface used to build rich Codex
  clients.
- OpenAI's [Codex subagents guide](https://learn.chatgpt.com/docs/agent-configuration/subagents.md)
  documents the Active/Done roster and agent inspection interaction used as the
  product reference.
- Anthropic's [Claude Agent SDK type definitions](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py)
  define subagent lifecycle hooks and agent attribution, while the
  [SDK changelog](https://github.com/anthropics/claude-agent-sdk-python/blob/main/CHANGELOG.md)
  records hook event streaming and subagent transcript helpers.
- OpenCode's [agent documentation](https://opencode.ai/docs/agents/),
  [SDK documentation](https://opencode.ai/docs/sdk/), and
  [server documentation](https://opencode.ai/docs/server/) describe child
  sessions, session messages/status, and server event subscriptions.
- Cursor's [CLI output documentation](https://docs.cursor.com/en/cli/reference/output-format)
  and [Background Agents API overview](https://docs.cursor.com/background-agent/api/overview)
  distinguish foreground CLI events from the separate cloud background-agent
  surface.
- xAI's [Grok CLI reference](https://docs.x.ai/build/cli/reference) and
  [headless/ACP guide](https://docs.x.ai/build/cli/headless-scripting) describe
  subagent availability and the foreground ACP `session/update` stream.
- The [ACP v2 prompt lifecycle](https://agentclientprotocol.com/rfds/v2/prompt)
  defines foreground prompt updates but does not currently provide the stable
  background child lifecycle required by this roster design.

Local compatibility inspection on 2026-07-22 used Codex CLI 0.145.0, Claude
Code 2.1.217, and OpenCode 1.18.4. It confirmed Codex `--remote`, Claude hook and
subagent-stream flags, and OpenCode `serve`/`attach`; those versions are evidence
for the design, not permanent minimum-version declarations.
