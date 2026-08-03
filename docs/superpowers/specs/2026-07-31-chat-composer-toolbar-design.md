# Chat Composer Toolbar Design

**Date:** 2026-07-31
**Status:** Approved design; implementation plan: `docs/superpowers/plans/2026-08-01-compact-chat-composer-toolbar.md`

## Summary

Replace the chat composer footer's text-heavy controls with a compact,
capability-driven toolbar. Keep the current provider icon and selected model,
but show the model's shortest available display name. The toolbar must never
offer agent or provider selection; that choice stays outside the composer.

The toolbar adds dedicated controls for Plan, Fast, effort, runtime/edit mode,
file attachments, context usage, and MCP server status. Plan is an icon-only
toggle: active means plan mode, while inactive switches the backend to the
normal build/default mode without showing a Build icon or label.

## Goals

- Prefer compact icon buttons over persistent text labels.
- Keep the selected provider's existing icon and a short model name.
- Restrict model selection to models owned by the already-active provider
  instance.
- Expose Plan, Fast, effort, and runtime/edit controls independently.
- Allow arbitrary file attachments, preserving the existing image workflow.
- Show real context usage and MCP status for the selected provider.
- Remain predictable when a provider does not expose a capability or status.
- Preserve keyboard access, focus visibility, tooltips, and responsive use.

## Non-goals

- Selecting or switching agents/providers from the composer toolbar or its
  model picker.
- Showing a Build button, icon, or label.
- Combining MCP servers from multiple providers.
- Inventing context-usage categories that the provider does not report.
- Adding controls for hypothetical provider capabilities.
- Redesigning provider selection elsewhere in the application.

## Toolbar Layout

The desktop layout is:

```text
[provider icon + short model] [Plan] [Fast] [effort] [runtime]
                              [paperclip] [context] [MCP] [send]
```

The two groups share one footer row when space permits. At narrow widths, the
left group scrolls horizontally while the attachment, status, and send actions
remain reachable. Existing compact-footer behavior may collapse unsupported or
secondary choices, but it must not reintroduce agent selection or text-heavy
combined controls.

All icon-only controls have an accessible name, a tooltip, a visible keyboard
focus state, and a minimum practical pointer target. Active toggles use the
existing selected/active treatment rather than a new color system.

## Controls

### Model

Keep the current provider instance icon. The trigger displays the model's
`shortName` when supplied and otherwise uses the existing display name with
width-constrained truncation. The tooltip retains the full provider and model
name.

Opening the picker shows models for the active provider instance only. Remove
the provider/agent rail and every path that can switch provider instances from
the composer picker. Provider selection remains available in its existing
non-toolbar location.

### Plan

Render one icon-only Plan toggle with Lucide's folded-map glyph when the
selected provider supports interaction mode changes. The route/map metaphor is
distinct from the existing task-list and Git-branch affordances.

- Inactive: backend interaction mode is build/default.
- Active: backend interaction mode is plan and the button is highlighted.
- Inactive never displays a Build icon or label.
- Tooltip text is `Enable plan mode` or `Disable plan mode`.

The existing provider interaction-mode state and dispatch path remain the
authority; the toolbar changes presentation, not mode semantics.

### Fast

Render a dedicated lightning-button toggle only when the active model exposes
the existing `fastMode` capability. It may include the short `Fast` label at
desktop widths, matching the reference treatment. Active and inactive states
write through the existing provider-option persistence path.

### Effort

Render effort as an icon made from increasing vertical bars. The number of
filled bars reflects the selected option's ordered level. The toolbar trigger
contains no effort text. Clicking it opens the existing labeled effort choices,
including prompt-injected choices such as ultrathink when supported.

### Runtime/Edit Mode

Render only the icon for the selected runtime mode. Clicking it opens the full
existing choices and descriptions: supervised, auto-accept edits, and full
access. The selected icon updates immediately after a choice, while the menu
retains the explanatory text.

### Attachments

Add an icon-only paperclip button backed by a native hidden file input that
allows multiple files. Paste and drag-and-drop continue to use the same shared
validation path.

Generalize the existing image attachment model to represent files:

- Images retain thumbnails, zoom previews, and native image delivery.
- Other files render as compact chips with filename, size, and remove action.
- The existing limit of eight attachments per message remains enforced.
- The existing 10 MiB per-file limit is enforced before upload and again on
  the server.
- Files are materialized under the existing attachment root using the current
  canonical-path and attachment-ID protections.
- Provider adapters use native file delivery where supported. Coding-agent
  providers without a native file part receive the safe materialized local path
  as an explicit attachment reference so they can inspect it with their normal
  file tools.

The thread message retains attachment metadata so non-image files remain
visible after send and reconnect. A provider-specific rejection is reported
before dispatch without silently dropping the file.

### Context Usage

Keep the existing context ring icon and popover. Show only measured values:
used tokens, maximum tokens when known, percentage, and total processed tokens
when reported. Do not fabricate the category breakdown from the reference
image because BiBCode does not currently receive those categories.

### MCP Status

Add an icon-only plug button for the active provider instance. Its popover lists
only servers reported by that provider, with normalized states such as
connected, starting/awaiting status, needs authentication, disconnected, and
error.

Reuse provider runtime MCP status events rather than introducing a second MCP
configuration system. Store the latest snapshot keyed by provider instance.
Switching providers immediately switches the displayed snapshot; disconnecting
or invalidating a runtime clears stale connected state. If the provider has not
reported status, show a neutral `Awaiting MCP status` empty state instead of
guessing. Providers without MCP status support do not render the button.

## Component Boundaries

- `ChatComposer` continues to own composer state and arranges the footer.
- The existing provider/model picker is reused in active-instance-only mode and
  loses its composer agent-selection affordance.
- Provider trait descriptors remain the source of Fast and effort options, but
  their toolbar presentation is split into focused controls.
- Existing interaction and runtime mode update callbacks remain authoritative.
- Attachment validation/materialization is shared by picker, paste, and drop.
- Context usage continues through `ContextWindowMeter`.
- A focused MCP status popover consumes provider-instance-keyed runtime state.

No new UI framework, icon package, or state library is introduced.

## State and Data Flow

1. The surrounding chat panel determines the active provider instance.
2. The model picker receives only that instance's models and can change only
   the model selection.
3. Plan, Fast, effort, and runtime controls write through their existing state
   and dispatch mechanisms.
4. File selection, paste, and drop enter one attachment-validation path. Valid
   files are staged, previewed, persisted, uploaded, and materialized for the
   selected provider at send time.
5. Provider runtime MCP events update a snapshot keyed by provider instance.
   The toolbar reads only the active instance's snapshot.
6. Context usage continues to derive from the active thread's latest context
   snapshot.

## Failure and Reconnect Behavior

- Unsupported controls are omitted rather than shown as misleading no-ops.
- Changing providers cannot carry model, MCP, effort, or Fast state into the
  newly selected provider.
- A provider disconnect clears connected MCP presentation and leaves a neutral
  awaiting/unavailable state.
- Failed attachment validation names the rejected file and reason.
- Failed attachment upload/materialization keeps the draft intact and prevents
  dispatch; no attachment is silently lost.
- Reconnect restores persisted attachment chips and rebuilds live MCP/context
  status from authoritative events.
- Existing send, stop, pending-question, and plan-follow-up actions retain their
  behavior.

## Testing Strategy

Use focused component and logic tests to cover:

- the model trigger prefers `shortName` and the picker cannot switch agents;
- inactive Plan dispatches build/default mode without rendering Build UI;
- active Plan styling and accessible tooltip text;
- Fast and effort controls render only from real provider descriptors and save
  through existing option state;
- effort bar level mapping and runtime icon selection;
- paperclip selection, paste, and drop share validation;
- non-image attachment chips, removal, persistence, send, reconnect, and
  provider rejection;
- server materialization rejects traversal, oversized files, and invalid
  metadata while accepting supported non-image files;
- context popover renders measured values only;
- MCP popover reads the active provider only and clears stale state on switch,
  disconnect, and reconnect;
- keyboard focus, accessible names, and compact responsive behavior.

Run targeted tests with `vp test`, then run the repository-required checks:

```sh
vp check
vp run typecheck
```

## Acceptance Criteria

1. The composer toolbar uses the compact layout described above and keeps the
   current provider icon.
2. No composer toolbar control or popup can select an agent/provider.
3. The model trigger uses the shortest supplied name and selects models only
   for the active provider instance.
4. Plan is an icon-only toggle; inactive means backend build/default mode and
   no Build UI is rendered.
5. Fast is a dedicated toggle, effort is an increasing-bars icon, and runtime
   mode displays only its selected icon.
6. The paperclip attaches arbitrary files through the same validated path as
   paste and drop; images retain their current preview behavior.
7. Context usage shows real active-thread values without invented categories.
8. MCP status lists only servers for the selected provider and cannot display
   stale connected state after a switch or disconnect.
9. Unsupported capabilities are omitted, and failures never silently discard
   attachments or state changes.
10. Relevant tests, `vp check`, and `vp run typecheck` pass.
