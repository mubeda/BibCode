# Local UI Copy and Activity Time Design

**Date:** 2026-08-16

## Outcome

Remove the final remote-host reference from the Add Project dialog's
accessible description and present Activity record start/end instants as
readable dates rather than raw canonical RFC 3339 strings.

## Scope

This change is owned by `apps/web`. It does not change environment selection,
desktop/WSL/browser policy, Activity contracts, persisted timestamps, provider
runtime behavior, or server schemas.

## Design

### Add Project description

`AddProjectDialog` will use the mode-neutral accessible description
`Choose how to add a project.` The description remains linked through the
dialog's existing `aria-describedby` relationship. It is correct for local
desktop, Windows desktop with WSL locations, and browser clients without
duplicating the workflow's location-presentation policy.

### Activity record timestamps

The active timestamp-format preference will flow through the existing
`ActivityPanelBinding` and `ActivityPanel` boundary into
`ActivityRecordDetail`. Started and ended instants will use the existing
long-form timestamp formatter so their clock style follows the user's
`locale`, `12-hour`, or `24-hour` setting.

Each rendered value remains a semantic `<time>` element. Its `dateTime`
attribute and tooltip retain the exact canonical RFC 3339 source value. If a
malformed value reaches this UI despite contract validation, the visible label
falls back to the source value rather than becoming blank or throwing.

## Testing

- Add Project DOM coverage will assert the complete accessible description and
  prove that neither visible nor screen-reader copy mentions hosts.
- Activity detail coverage will assert readable started/ended labels, user
  clock-format selection, exact `dateTime` and tooltip preservation, and the
  malformed-value fallback.
- Focused component tests run first under strict RED/GREEN discipline.
- Verification includes the complete web unit suite, `vp check`, workspace
  typecheck, a desktop rebuild, and Codex Computer Use recapture of both
  affected surfaces at normal and narrow widths.

## Alternatives Rejected

- **Desktop-only description branching:** duplicates environment-presentation
  policy and leaves unnecessary remote terminology in a shared dialog.
- **A new Activity-only `Intl.DateTimeFormat`:** duplicates the user's existing
  timestamp preference and formatter behavior.
- **Server-formatted timestamps:** crosses the server/UI ownership boundary,
  loses client locale preferences, and weakens canonical protocol data.
