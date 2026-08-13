# Claude Nested Cancellation and Single-Icon Activity UI Design

**Date:** 2026-08-12

**Status:** Approved for implementation

## Summary

Fix the remaining Claude nested-subagent cancellation gap and simplify the
Activity dock and Subagents roster.

The server will correlate a nested Claude actor with its exact background
`task_id` when Claude omits the nested `PostToolUse` launch result but still
provides one unambiguous, authenticated parent-local launch interval. Ambiguous
or conflicting evidence remains unsupported and never triggers provider I/O.
No provider-native identifier crosses the existing server boundary.

The web UI will use one provider icon in the floating Activity dock and one
provider icon per roster row. It will communicate hierarchy with indentation
and a connector rather than overlapping icons. Parent rows will expose an
explicit **Stop subtree** action; ordinary controllable rows will expose
**Stop**. Counts, status, and elapsed time will have separate layout regions so
they cannot overlap at supported widths.

This is a correction and presentation refinement of the implemented
[Targeted Activity Subtree Cancellation Design](./2026-08-11-targeted-activity-subtree-cancellation-design.md).
Its server-authoritative subtree, fencing, privacy, retry, and provider-isolation
decisions remain unchanged.

## Evidence and Root Cause

Original-resolution desktop verification used a freshly built release bundle
and one BiBCode process. Codex stopped a selected parent plus its nested child
while leaving the sibling active. Claude displayed the parent, nested child,
and sibling, but the nested child had no Stop action. Stopping the parent left
the nested child running.

The live Claude event path provided:

- the nested Agent tool invocation and its `tool_use_id`;
- the exact parent Agent ownership;
- `task_started` with the invocation's exact `task_id`;
- authenticated `SubagentStart` with the child `agent_id` and exact
  `parent_agent_id`; and
- the canonical Activity parent edge.

Claude did not provide the nested `PostToolUse` result containing the launched
child `agent_id` while the parent remained active. The current correlator
requires that result before installing a private `ClaudeTask` target, so the
child was observable but explicitly unsupported.

The screenshots also exposed two intentional but undesirable layout choices:

- the dock rendered one overlapping provider circle per actor even though the
  adjacent counts already represented multiplicity; and
- each roster row overlapped a provider icon with a generic actor icon, which
  was especially redundant when both resolved to the same bot glyph.

Expanded dock section rows also packed section name, active count, done count,
clock icon, and elapsed time into one narrow horizontal line.

## Goals

- Make the common single nested Claude launch cancellable while it is running,
  even when the nested launch result is delayed or absent.
- Preserve exact selected-subtree cancellation: parent and nested descendants
  stop; siblings and the root continue.
- Fail closed for concurrent, ambiguous, conflicting, stale, or incomplete
  Claude correlation.
- Preserve the existing 200-entry bounds, generation fencing, terminal
  cleanup, native-ID privacy, and no-root-interrupt guarantee.
- Show one provider icon in the Activity dock and one provider icon per roster
  row.
- Make canonical parent/child relationships immediately visible in the
  Subagents roster.
- Keep status, elapsed time, counts, and actions readable without overlap.
- Preserve row navigation, keyboard access, focus behavior, cancellation
  revisions, `Stopping`, partial retry, and terminal read-only behavior.
- Rebuild and visually verify the exact packaged desktop application with both
  Codex and Claude.

## Non-goals

- Changing Activity protocol version 2, RPC request shapes, persistence, or
  public contracts.
- Exposing Claude `task_id`, `agent_id`, tool-use IDs, transcript paths, or
  other native control identities to the client.
- Inferring association from display name, prompt text, semantic similarity,
  row order, elapsed time, or unrestricted arrival timing.
- Making an ambiguous nested Claude actor cancellable.
- Falling back to Claude root `interrupt`, the chat composer Stop action, an OS
  process signal, or a cooperative model prompt.
- Reading transcript files on the cancellation hot path.
- Adding a Stop All action, confirmation dialog, or optimistic client-side
  cancellation state.
- Turning the Activity roster into a dense administration table.

## Approved Decisions

| Decision | Approved choice |
| --- | --- |
| Missing nested Claude launch result | Bounded, parent-local, unambiguous correlation |
| Concurrent or conflicting candidates | Remain unsupported; zero provider I/O |
| Public protocol | No change |
| Dock icons | One provider icon total |
| Roster icons | One provider icon per record |
| Hierarchy | Indentation plus connector |
| Parent action copy | **Stop subtree** |
| Ordinary actor action copy | **Stop** |
| Compact action | Visible text action, not an unlabeled 8-pixel square |
| Multiplicity | Counts, never repeated provider icons |
| Final verification | Fresh exact bundle, one process, Codex Computer Use, Codex and Claude screenshots |

## Server Design

### Ownership and boundaries

`apps/server` remains the owner of Claude correlation, native targets, provider
dispatch, and subtree cancellation. The existing
`ClaudeTaskControlCorrelator` remains generation-owned by one Claude provider
runtime. The Activity control registry continues to receive only opaque native
targets and publish only canonical control state.

No web, client-runtime, contract, RPC, or SQLite type gains a provider-native
field.

### Parent-local launch interval

The correlator will retain enough authenticated hook state to represent an
open nested Agent launch interval:

1. Authenticated `PreToolUse` identifies the exact source `agent_id`,
   `tool_use_id`, and Agent/Task tool class.
2. The provider stream identifies the nested invocation's exact
   `parent_tool_use_id`, preserving the existing proof that the source actor is
   the active verified parent.
3. `task_started` binds the invocation's exact `tool_use_id` to an exact
   background `task_id` and an accepted absent, `local_agent`, or
   `remote_agent` task type.
4. Authenticated `SubagentStart` provides the new child `agent_id` and exact
   `parent_agent_id`.

These facts are stored only within the current runtime generation. The open
launch interval closes on its matching `PostToolUse`, `PostToolUseFailure`,
terminal task lifecycle, source-parent retirement, cancellation, runtime
disablement, replacement, or shutdown.

### Unambiguous fallback association

The normal explicit path remains authoritative: an accepted `PostToolUse`
launch result binds its `tool_use_id` to the returned child `agent_id`, and all
existing exact source and lineage checks still apply.

The fallback path may install a child target only when all of the following are
true in one session and generation:

- the source parent is verified, active, and already has an exact native
  target;
- exactly one open, unmatched nested Agent launch belongs to that parent;
- that launch has exactly one accepted `task_started` `task_id`;
- exactly one verified, unmatched child names that source parent as its exact
  `parent_agent_id`;
- neither tool, task, parent, nor child is tombstoned, conflicted, terminal, or
  already assigned; and
- installing the association keeps every correlator collection within
  `ACTIVITY_PAGE_MAX_LENGTH`.

The association is an exact join of provider identities inside one
authenticated parent-owned launch interval. It does not compare names,
prompts, roles, descriptions, or timestamps. If either side has cardinality
other than one, the fallback emits no Install effect. A later explicit launch
result may resolve the ambiguity through the normal exact path.

If later explicit evidence contradicts an installed fallback association, the
correlator immediately retires the target and tombstones the conflicting
identity chain. It never silently remaps the actor to a different task.

### Bounds and lifecycle

Pending parent-local launch state shares the Activity page bound of 200. It is
not an unbounded queue and does not schedule one task or timer per candidate.
Reconciliation operates over the existing bounded correlator state and must
retain early quiescence.

Generation reset replaces all pending state atomically. Terminal
`task_notification`, `SubagentStop`, cancellation completion, capability
downgrade, provider replacement, and shutdown retire exact mappings and
pending candidates through the existing tombstone and cleanup rules. Duplicate
facts remain idempotent. A stale generation cannot install or retire a current
target.

### Cancellation behavior

After the fallback installs `ProviderActivityNativeTarget::ClaudeTask`, the
existing server-authoritative topology and cancellation service perform the
operation:

1. The client submits only the canonical selected actor and revision fences.
2. The server computes the selected canonical subtree.
3. Claude receives one exact `stop_task` for the parent and one for the nested
   child, subject to selected-first dispatch and existing bounded concurrency.
4. The sibling and root receive no request.
5. Provider terminal events remain authoritative for lifecycle completion.

If the fallback remains ambiguous, the child retains an `unsupported` control
row and no Stop action. Cancelling a parent with an unsupported descendant
keeps the existing partial/residual behavior; it never widens the provider
target.

## Web UI Design

### Floating Activity dock

The collapsed dock renders exactly one provider icon for the Activity scope,
then textual active and done counts. It does not render one icon per actor and
does not use negative spacing.

Example:

```text
[Claude]  Active 1  Done 2
```

The accessible summary retains the exact section counts. Multiplicity is
communicated only by those counts.

When expanded, each section uses two layout regions:

- primary line: section name plus active/done counts; and
- secondary metadata line: elapsed information for the longest-running active
  record, when present.

The elapsed label does not add another provider icon and does not compete with
the counts in one nowrap row. Compact mode may omit secondary elapsed metadata
when the available width cannot present it without truncating the primary
state.

### Hierarchical Subagents roster

Each row renders one provider icon. The generic actor icon is removed for
subagent rows because the Subagents section and actor record already provide
that meaning. Background-task rows retain their one appropriate work-item icon.

Canonical `parentActorId` relationships determine presentation:

- a child whose parent is present in the same reconciled roster is placed
  immediately after its parent subtree;
- the child is indented and connected with a subtle line;
- the parent metadata reports the authoritative active descendant count; and
- missing, paginated-out, cyclic, or invalid parents do not invent hierarchy.
  Those records remain at root indentation and keep stable fallback ordering.

Tree ordering is a presentation projection of the bounded reconciled roster.
It does not change canonical identity, server subtree computation, query
pagination, or client authority.

### Row content and actions

The row layout has three stable columns: one icon, flexible content, and one
action area.

The flexible content contains:

- actor name;
- server-authoritative status or `Stopping`;
- role/relationship metadata; and
- elapsed or completed duration on a metadata line.

An available parent with active descendants shows **Stop subtree**. An
available actor without active descendants shows **Stop**. Requested controls
show disabled **Stopping**. Unsupported and terminal actors show no mutation
action. The existing accessible label retains the actor name and exact active
descendant count, such as `Stop Alpha and 1 child agent`.

The action is a visible text button with a normal interactive hit area. It is a
sibling of the row-navigation button, stops propagation, preserves focus, and
never nests interactive elements.

### Responsive behavior

The icon and action columns never shrink. Actor name and optional summary may
truncate within the flexible column. Metadata wraps or selectively omits the
least important elapsed detail before it overlaps the action. Parent/child
indentation is bounded so deep trees cannot eliminate the flexible content
column.

The right panel, `RightPanelSheet`, and narrow desktop window use the same
component behavior. No separate mobile source of truth is introduced.

## Error Handling and Safety

- Ambiguous Claude correlation remains explicit `unsupported`; it is not an
  error banner and does not expose a disabled mystery action.
- A cancellation failure continues to use bounded, safe client copy. Raw
  provider payloads and native IDs remain absent.
- Control-only deltas remain authoritative over cached roster pages.
- Old environment, scope, operation, actor, and invocation results remain
  fenced by the existing client and server revisions.
- Provider capability downgrade clears exact targets before returning and
  cannot fall back to root interrupt.
- Partial cancellation shows the existing residual count and **Retry
  remaining** action; UI hierarchy does not recompute residual membership.

## Test Strategy

### Server RED/GREEN coverage

Add focused correlator tests proving:

- a real nested event sequence without nested `PostToolUse` installs the exact
  child `ClaudeTask` target;
- all supported event orders within the parent-owned interval converge;
- one parent with two open nested invocations remains unsupported until
  explicit evidence resolves each association;
- two unmatched children, cross-parent children, invalid parent identity,
  missing parent target, duplicate tasks, conflicting late `PostToolUse`, and
  stale generations fail closed;
- terminal events and restart clear both installed and pending state;
- bounds and tombstones remain fixed under churn; and
- native IDs remain redacted from Debug and operational logs.

Extend the production Claude fixture and public WebSocket RPC scenario to omit
the nested launch result intentionally. Cancelling parent A must capture exact
ordered `stop_task` requests for task A and its nested child, no task B, and no
root interrupt. The sibling and root must continue producing observable
activity. Ambiguous nested launches must remain unsupported and cause zero
provider I/O.

Run the existing Codex subtree fixture unchanged to prove provider isolation.

### Web RED/GREEN coverage

Add DOM and accessibility tests proving:

- the dock has one provider glyph regardless of actor count;
- the expanded section keeps counts and elapsed metadata in separate regions;
- each subagent row has one provider glyph and no generic actor glyph;
- parent/child records render in canonical hierarchical order with bounded
  indentation;
- absent/paginated/invalid parents use deterministic root fallback;
- parent action copy is **Stop subtree** and ordinary action copy is **Stop**;
- accessible labels retain exact subtree impact;
- Stop remains a sibling of navigation, keyboard reachable, focus preserving,
  and non-navigating;
- requested, partial, unsupported, and terminal states retain their current
  authority and mutation surfaces; and
- right-panel and sheet fixtures remain usable at narrow widths.

### Broader verification

Run focused Claude runtime/provider/production cancellation suites, focused
Activity dock/roster/panel/surface tests, full affected server and web suites,
workspace typecheck, `vp check`, Rust formatting, and warnings-denied Clippy.

Then:

1. Build the exact release desktop bundle from the final worktree.
2. Verify no old BiBCode process remains.
3. Launch exactly that absolute bundle path and confirm one process.
4. Use Codex Computer Use, never Orca, to create a parent, nested child, and
   sibling for Codex and Claude.
5. Capture before/after original-resolution screenshots.
6. Verify Codex and Claude each stop only the selected canonical subtree.
7. Verify one dock icon, one row icon, visible hierarchy, readable elapsed
   metadata, no overlap, no clipping, correct focus, and no stranded active
   child without a Stop action.

## Living Documentation

Implementation will update the living Activity architecture, Claude provider
guide, provider architecture, and workspace UI documentation where the
correlation and presentation invariants change. The historical implemented
design remains immutable.

## Rejected Alternatives

### Transcript-file reconstruction

Transcript recovery adds filesystem I/O, path validation, cancellation, and
latency to a hot control boundary. The live authenticated hook and provider
stream already carry enough information for the approved unambiguous
parent-local association. Transcript reconstruction is rejected.

### Keep waiting for nested `PostToolUse`

The live provider can keep a nested Agent tool invocation open while its child
runs. Waiting leaves a visibly active child permanently unsupported during the
period when Stop is needed. This preserves the defect and is rejected.

### Match by name, prompt, role, order, or elapsed time

These values are non-unique or presentation-oriented and can target the wrong
task. They are rejected.

### Retain repeated dock glyphs

Counts already communicate multiplicity. Repeated icons consume horizontal
space, overlap by design, and collide visually with elapsed metadata. They are
rejected.

### Retain provider-plus-actor icon pairs

The section already establishes the record kind, and provider-specific actor
icons often render the same bot metaphor. The pair adds noise without new
information. It is rejected.

### Dense operations table

A table makes comparison efficient but changes the conversational Activity
surface into an administrative dashboard and performs poorly in the narrow
right panel. It is rejected in favor of the approved hierarchical roster.
