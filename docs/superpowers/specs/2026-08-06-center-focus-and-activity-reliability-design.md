# Center Focus and Activity Reliability Design

**Date:** 2026-08-06

**Status:** Approved.

## Summary

Fix three regressions discovered while preparing the v0.3.4 marketing build:

1. a center terminal can reclaim keyboard focus after the user clicks a chat composer in another split pane;
2. Codex subagent activity can disappear when Codex App Server exposes child threads through `subAgentActivity` items and direct `thread/read`, but omits them from `thread/list`;
3. multi-line Activity roster rows overlap at desktop breakpoints.

The fixes preserve the existing center-layout model and activity protocol. They
change no public Effect RPC schema, persisted activity shape, authentication
boundary, desktop bridge, or provider-facing command. The web application owns
focus eligibility and presentation. The Rust Codex adapter owns provider-native
activity discovery and recovery.

## Goals

- A visible terminal focuses only while its center pane is the focused pane.
- Clicking a chat composer transfers keyboard input permanently until another
  explicit terminal activation occurs.
- Codex actors appear from valid `subAgentActivity` hints even when descendant
  `thread/list` results are empty.
- Restart and reconnect recovery can rediscover those hinted actors from bounded
  root and child history.
- Existing Codex versions that return descendants from `thread/list` continue
  to work.
- Activity roster and expanded Activity dock rows grow to fit their content at
  every responsive breakpoint in light and dark themes.
- All provider activity work remains bounded, generation-fenced, cancellable,
  deduplicated, and redacted by the existing activity pipeline.

## Non-Goals

- Change center-panel split creation, persistence, drag-and-drop, or close
  behavior.
- Automatically focus a terminal merely because it is visible.
- Add a new activity protocol version, activity record kind, RPC, or database
  migration.
- Infer Codex activity by scraping terminal output or rollout files.
- Remove the current `thread/list` reconciliation path.
- Redesign the Activity panel, dock, record-detail surface, or status semantics.
- Change Claude, OpenCode, or provider-terminal discovery behavior.
- Add unbounded polling or background tasks.

## Evidence and Root Causes

### Terminal focus theft

`ChatView` currently replaces a terminal's real `focusRequestId` with `0` when
the terminal's center pane loses focus. `ThreadTerminalPanel` still considers
the only terminal in that surface eligible for autofocus. `TerminalViewport`
treats the changed value as a fresh activation request and schedules
`terminal.focus()` on the next animation frame. The synthetic `0` therefore
becomes a new request rather than an inactive sentinel.

Reloading commonly hides the defect because the initial `0` request is already
fulfilled. The failure is triggered by the transition from a non-zero request
to the synthetic `0` after a split terminal has received focus.

### Missing Codex activity

The current Codex tracker validates `subAgentActivity` items but emits no actor
mutation and retains no child ID. It asks the runtime to reconcile, and the
runtime discovers actors only from `thread/list({ ancestorThreadId })` before it
issues `thread/read`.

Codex CLI 0.146.1 can return an empty descendant list for real spawned
subagents. The root `thread/read` response still includes bounded
`subAgentActivity` items with `agentThreadId`, `agentPath`, and lifecycle kind,
and direct `thread/read` for those child IDs succeeds with parent, nickname,
role, status, turns, and results. Because BiBCode discards the hints and gates
all reads behind list discovery, the activity scope remains live with zero
actors.

### Overlapping Activity rows

The shared `Button` default size emits both `h-9` and `sm:h-8`. Activity rows
add `h-auto`, which supersedes only the unprefixed height. At desktop widths,
`sm:h-8` wins and forces a row containing a title, summary, and metadata into a
32-pixel box. The overflow remains visible and paints over following rows.

The roster contains three distinct records in normal document flow; neither
record duplication nor virtualization causes the overlap.

## Architecture and Ownership

### Web focus ownership

The focused center pane is the source of truth for whether a center terminal
may claim keyboard focus. `ChatView` passes two independent values through
`CenterTerminalPanel` to `ThreadTerminalPanel`:

- the unchanged monotonic `focusRequestId`, representing explicit terminal
  activation intent;
- a focus-eligibility boolean derived from the center render context.

`ThreadTerminalPanel` combines that eligibility with its existing active
terminal selection before setting `TerminalViewport.autoFocus`. Callers that do
not supply the new eligibility value keep the existing behavior, preserving
right-panel terminal semantics.

`TerminalViewport` remains the owner of deferred xterm focus, initial-fit
ordering, fulfilled-request tracking, and animation-frame generation guards.
It must not reinterpret a magic request ID. When eligibility is false it does
not schedule or fulfill the request. If the pane later becomes eligible while
the same request remains outstanding, the existing effect may fulfill it once.

Pointer interaction with the terminal continues to focus xterm directly. The
change governs only programmatic autofocus.

### Codex activity ownership

The Rust Codex activity adapter remains the only layer that interprets
provider-native `subAgentActivity` data. The canonical activity repository and
wire contracts continue receiving ordinary `UpsertActor` and `AppendEntry`
mutations.

The tracker validates a hint only when:

- its owning thread is the current root or a verified child;
- `agentThreadId` and `agentPath` are non-empty and within existing payload
  bounds;
- the kind is one of `started`, `interacted`, or `interrupted`;
- the hinted ID is neither the root nor an already rejected cycle.

A valid hint records the parent relationship, seeds or updates a provisional
actor, and returns the hinted native child ID as reconciliation work. A root
owner produces no canonical parent; a verified child owner supplies that
actor's canonical ID. Until direct metadata arrives, the final non-empty
`agentPath` segment becomes the bounded fallback name and the role remains
unset. `started` and `interacted` map to `running`; `interrupted` maps to the
terminal `interrupted` state. The provider event's accepted timestamp supplies
`startedAt`/`updatedAt` and, for interruption, `terminalAt`. A later non-terminal
hint may reopen a terminal actor only when its accepted provider timestamp is
equal to or newer than the terminal update, matching the tracker's existing
authoritative-reopen ordering rule.

Authoritative `thread/read` metadata later refines the provisional actor's name,
role, timestamps, status, summary, and entries. Duplicate hints are idempotent
through the existing canonical-ID and mutation no-op rules.

The runtime maintains pending hinted child reads inside the current activity
generation. It merges them with IDs discovered by `thread/list`, deduplicates
them, and processes them as a bounded breadth-first work queue. Each successful
child read may expose additional valid nested hints, which enter the same queue.
The total accepted/read descendants remains capped by the existing reconciliation
limit. The existing epoch and cancellation token fence every request and
mutation, so results from a replaced root or disabled activity generation are
discarded.

### Recovery flow

Each reconciliation pass retains legacy descendant listing and adds bounded
hint recovery:

1. Read the current root with turns when `thread/read` is supported.
2. Scan only the existing bounded recent-turn/item window for valid
   `subAgentActivity` hints.
3. Merge hinted IDs with descendants returned by `thread/list`.
4. Read each unique child directly, validating that the response ID matches the
   request and its parent is the root or an already verified actor.
5. Apply actor metadata and bounded entries, then enqueue valid nested hints
   found in that child's bounded history.
6. Publish the accumulated canonical activity mutations through the existing
   repository path.

An empty successful list is not an error and does not suppress direct hinted
reads. If `thread/read` is incompatible, the runtime keeps list-derived actor
summaries, marks method capability according to the existing downgrade policy,
and does not invent history. A transient read or list failure retains known
data and uses the existing stale/retry behavior. Provider payloads never bypass
normal sanitization, authorization, or persistence.

### Intrinsic button sizing

The shared web `Button` primitive gains a content-sized size variant. It uses
responsive minimum heights and horizontal padding but never emits a fixed
height. Multiline Activity roster rows and expanded Activity dock controls use
that variant instead of trying to override only one responsive height utility.

This puts responsive sizing policy in the shared primitive and prevents each
consumer from duplicating `h-auto sm:h-auto` overrides. Fixed-height icon and
single-line button variants remain unchanged.

## Failure and Lifecycle Behavior

### Focus

- A stale animation-frame callback remains invalidated by the existing focus
  generation guard.
- Losing pane focus before the frame runs prevents terminal focus.
- Output, metadata, renderer replacement, WebGL changes, and unrelated renders
  do not create focus intent.
- Hiding and reshowing a terminal does not synthesize a new request.

### Activity discovery

- Malformed, out-of-scope, root-self-referential, or cyclic hints are ignored.
- Duplicate hints and duplicate list results do not cause duplicate actors,
  reads, entries, or revisions.
- Child responses with a mismatched ID or unverifiable parent are ignored.
- Reconciliation observes the existing descendant, turn, entry, queue, and
  page bounds; malicious provider payloads cannot create unbounded memory or
  I/O.
- Disabling Chat activity, replacing the root, disconnecting, or shutting down
  cancels pending work and invalidates late results.
- A partial pass never deletes already valid actors merely because one discovery
  source returned no rows.
- Unsupported direct reads preserve truthful capability downgrade rather than
  claiming recovered history.

### Activity layout

- Long names still truncate on the title line.
- Summaries remain clamped to two lines.
- Metadata remains visible below the summary.
- Each row's hit target and focus ring cover its full intrinsic height.
- Light and dark modes share the same geometry and retain current colors.

## Data, Security, and Performance Boundaries

- No schema, RPC, or SQLite migration is required.
- The authenticated `orchestration:read` boundary and scope binding remain
  unchanged.
- Only provider-native structured data from the owned Codex session is used.
- Existing label/detail bounds, control-character normalization, secret
  redaction, and raw-reasoning exclusion remain authoritative.
- Root history adds at most one bounded read per reconciliation pass. Child
  reads are deduplicated and capped by the current descendant limit.
- No new long-lived task, polling interval, or unbounded collection is added.

## Living Documentation Changes

Implementation updates:

- `docs/architecture/activity-observation.md` to state that Codex structured
  recovery merges descendant listing with validated bounded
  `subAgentActivity` hints and direct reads;
- `docs/providers/codex.md` to document the same provider-specific compatibility
  behavior;
- `docs/user/workspace-ui.md` only if the existing center-focus description
  needs an explicit invariant that inactive panes cannot autofocus terminals.

The Activity layout correction does not change user-facing behavior and needs
no new architectural documentation.

## Testing Strategy

Use test-driven development and keep each regression at its nearest behavioral
seam.

### Web focus tests

- A center terminal receives an unchanged request ID plus pane-focus
  eligibility.
- Changing eligibility from true to false does not convert the request ID to a
  sentinel or schedule focus.
- A token change while ineligible does not focus or fulfill the request.
- Returning eligibility to true can fulfill the still-outstanding request once.
- Clicking/focusing a chat composer in another split remains the keyboard input
  target after queued animation frames flush.
- Existing initial-fit, reconnect, hide/show, WebGL, and pointer-focus tests
  continue to pass.

### Codex provider tests

- Reproduce Codex 0.146 behavior: `thread/list` remains empty, root history
  contains three valid hints, and direct reads return the three children.
- Assert all three actors are published with correct parentage, metadata,
  terminal state, summaries, and bounded entries.
- Recover nested children through hints found in a directly read child.
- Deduplicate repeated live and recovered hints.
- Reject malformed IDs/paths/kinds, mismatched read IDs, out-of-scope parents,
  self-links, cycles, and IDs beyond the descendant bound.
- Verify cancellation and epoch replacement prevent stale read results from
  publishing.
- Preserve coverage for legacy list-only discovery and incompatible
  `thread/read` downgrade.

### Activity layout tests

- The content-sized button variant emits no fixed height at base or responsive
  breakpoints and retains the expected minimum hit-target height.
- Roster and expanded dock multiline controls opt into the content-sized
  contract.
- Roster content, order, status, summary clamp, accessible name, and selection
  behavior remain unchanged.
- Exact-bundle desktop inspection in light and dark modes confirms consecutive
  rows have distinct vertical boxes with no clipping or overlap.

### Required validation

Run focused web component tests and the affected Codex server tests after each
behavior change. Before completion run:

- the broader applicable web and server test suites;
- `vp test`;
- `vp check`;
- `vp run typecheck`;
- `cargo fmt --all --check`;
- Clippy for the affected server targets with warnings denied;
- `vp run build:desktop`;
- final `git diff --check`, `git diff`, and `git status --short` review;
- Codex Computer Use against the exact worktree-built app for terminal focus,
  Codex activity, and Activity row layout in light and dark themes.

## Alternatives Considered

### Continue using `0` as an inactive focus sentinel

Rejected. `TerminalViewport` treats every changed ID as activation intent, so a
sentinel remains coupled to fulfilled-request state and can regress during
future request sequences.

### Guard terminal focus with `document.activeElement`

Rejected. It races the queued animation frame, couples xterm behavior to DOM
implementation details, and cannot express pane ownership reliably across
WebKit and browser hosts.

### Map hints to actors without direct reads

Rejected. It makes actors visible quickly but cannot reliably obtain provider
names, roles, completion state, results, or nested topology. Actors can remain
permanently provisional after reconnect.

### Replace listing with rollout-file parsing

Rejected. Rollout files cross a filesystem/process boundary, may not exist on
remote environments, and would duplicate the supported App Server protocol.

### Poll every global Codex thread

Rejected. It is expensive, risks cross-session attribution, and weakens
boundedness and ownership validation.

### Add `sm:h-auto` only to Activity rows

Rejected as the primary design. It repairs one breakpoint in one consumer but
leaves a fragile responsive override pattern for every multiline button. A
content-sized shared variant expresses the actual design-system contract.

## Acceptance Criteria

1. After splitting a chat and terminal, clicking the chat composer makes all
   subsequent typing go to the composer until the terminal is explicitly
   activated again.
2. Codex subagents render live and after reconnect when `thread/list` returns
   no descendants but validated hints and direct reads are available.
3. Legacy list-based Codex discovery and capability downgrades still work.
4. Activity roster and expanded dock rows never overlap or clip at supported
   desktop widths in light or dark mode.
5. Activity protocol, persistence, authorization, redaction, and provider
   boundaries remain unchanged.
6. Focused regressions, broader checks, Rust gates, desktop build, and exact-app
   visual/interaction verification all pass.
