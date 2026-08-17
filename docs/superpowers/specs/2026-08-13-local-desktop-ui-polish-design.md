# Local Desktop UI Polish Design

**Date:** 2026-08-13

**Status:** Approved in conversation; pending written-spec review

## Summary

Polish three desktop UI surfaces and make BiBCode's current desktop product
presentation local-only without deleting its remote-environment functionality:

- compact discovered-worktree rows so long host paths cannot overflow the
  sidebar;
- align Activity roster metadata beneath its title instead of beneath the
  provider icon; and
- hide remote-device connection affordances on the macOS, Linux, and Windows
  desktop applications while retaining Windows WSL as a same-device backend.

The remote transport, persistence, contracts, routes, and server capabilities
remain implemented. Browser/hosted presentation remains unchanged. This design
targets the v0.3.14 desktop application and must not use or validate v0.3.13.

## Goals

- Make discovered worktrees readable at narrow sidebar widths.
- Preserve the exact full candidate path in tooltip, focus, and accessibility
  presentation without repeating it visibly on every row.
- Give Activity titles and elapsed metadata a stable shared text column.
- Establish one source of truth for whether remote-environment UI is presented.
- Keep WSL visible as a Windows-local environment and usable wherever a mapped
  WSL backend is available.
- Preserve Claude, Codex, Cursor, and OpenCode visibility and keep Grok hidden
  from ordinary provider action surfaces.
- Verify the packaged desktop visually through Codex Computer Use and
  original-resolution screenshot inspection.

## Non-Goals

- Removing SSH, pairing, Tailscale, relay, remote-environment, or network
  exposure functionality from the server, desktop bridge, contracts, or data
  model.
- Migrating or deleting saved remote environments or cached remote projects.
- Changing browser/hosted connection workflows.
- Treating WSL as a remote device.
- Redesigning worktree discovery, Activity lifecycle, or provider contracts.
- Changing provider installation detection, authentication, sessions, or
  default models.

## Approved Design

### Central desktop presentation policy

`apps/web` will own a pure environment-presentation policy derived from the
existing runtime mode and host platform. It will not read process globals,
perform I/O, mutate the environment catalog, or own connection state. Tests can
construct every mode explicitly.

The policy is the sole presentation source for:

- which environment targets appear in Add Project;
- whether Add Project needs a location selector;
- which sections appear on the Connections settings route;
- whether a settings/navigation action may open remote connection controls;
- whether pairing, relay-install, BiBCode Connect, SSH, Tailscale, advertised
  endpoint, or network-exposure affordances mount; and
- whether an unavailable-environment action may offer a connection or retry
  control for that target.

It filters presentation only. The complete environment catalog remains in
client state, saved remote records remain readable, and existing backend
functionality remains callable when this policy is changed in a future release.

| Runtime presentation | Primary local | WSL | SSH/remote hosts | Pairing, relay, Tailscale, exposure |
| --- | --- | --- | --- | --- |
| Browser/hosted | Existing behavior | Existing behavior | Visible | Visible |
| macOS desktop | Visible | Hidden | Hidden | Hidden |
| Linux desktop | Visible | Hidden | Hidden | Hidden |
| Windows desktop | Visible | Visible | Hidden | Hidden |

The Windows WSL settings section remains visible even when no distribution is
currently mapped, using its existing detection, status, and setup presentation.
Add Project lists only usable mapped WSL targets; it does not offer an unusable
location.

### Add Project data flow

Add Project will consume the policy-filtered environment targets rather than
mapping every environment record directly.

- With only the primary local target, the Host/Location field is omitted.
- On Windows, when at least one usable WSL target exists, the field is labelled
  **Location** and offers **This device** plus the mapped WSL locations.
- macOS and Linux never expose a remote-host selector in the desktop build.
- Browser/hosted mode keeps its current host-selection behavior.

Folder picking and project creation continue through the selected target's
existing workflow. The policy does not synthesize environments or change path
semantics.

### Settings, navigation, and direct routes

The desktop settings/navigation presentation will be explicit:

- Windows shows a **Local environment** settings entry backed by the existing
  Connections route, but that route renders only local/WSL content.
- macOS and Linux show no Connections or remote-device settings entry.
- Direct navigation to the Connections route on macOS/Linux redirects to the
  General settings route.
- Browser/hosted mode renders the existing complete Connections page.

Desktop entry points outside Settings follow the same policy. BiBCode Connect
footer controls, pairing links, remote-environment dialogs, SSH host controls,
Tailscale controls, network exposure controls, advertised endpoints, and relay
client installation prompts do not mount in local-only desktop presentation.

Unavailable local or WSL environments may keep their existing local retry and
diagnostic actions. Existing saved remote projects may remain visible as stored
data, but desktop banners and menus do not offer Connect, Retry, Pair, or
Connections actions for those remote targets. Passive availability text and
safe removal actions may remain.

### Discovered worktree card

Within each environment/project result, candidates are subgrouped by their
exact parent directory. Each parent directory appears once in a constrained
block row, so candidates from different roots such as `conductor/workspaces`
and `orca/workspaces` are never presented under a misleading shared path.
Candidate rows then show:

- the branch/worktree display name as the primary visible label;
- an optional concise secondary discriminator only when two candidates in the
  same parent subgroup would otherwise have the same visible name; and
- an **Add** action pinned to the trailing edge.

The full exact candidate path remains the tooltip and accessible description for
the candidate. It must be available on pointer hover and keyboard focus.

All text-bearing flex/grid ancestors use an explicit shrink boundary. The path
and candidate content are block-level constrained elements, so an unbroken or
deep path cannot widen the card, cover the Add action, or escape the sidebar.
**Keep hidden** and **Add all** retain their existing behavior.

### Activity roster geometry

Expanded Subagents and Background Tasks rows use two stable columns:

1. a fixed icon/status rail; and
2. a shrinking vertical text column.

The text column contains the title/count row followed by the elapsed/status
metadata row. Metadata aligns with the title rather than the icon. Existing
row actions, hierarchy indentation, lifecycle labels, keyboard behavior, and
compact-dock presentation remain unchanged.

## Failure and Recovery Behavior

- An unknown desktop platform fails closed to local-only desktop presentation
  rather than exposing remote controls accidentally.
- Absence of a mapped WSL backend removes it only from Add Project; the Windows
  Local environment settings entry remains available for status/setup.
- A stale saved remote project is not deleted or rewritten. Its connection
  affordances are simply absent in local-only desktop presentation.
- A failed local/WSL retry continues to use existing error state and recovery;
  the policy introduces no new asynchronous work.
- Tooltip failure or unavailable pointer hover does not hide the path from
  keyboard focus or the accessible description.
- Narrow worktree and Activity layouts must shrink or truncate; they must never
  introduce horizontal scrolling or overlap actions.

## Ownership and Boundaries

- `apps/web` owns the presentation policy, component rendering, route gating,
  accessibility, and UI tests.
- Existing environment identity helpers remain the source of truth for primary,
  desktop-local WSL, and remote targets. The UI will not duplicate that
  classification with display-name checks.
- `packages/contracts`, `packages/client-runtime`, `apps/server`, and
  `apps/desktop` retain their existing remote capabilities and persisted data.
- No public schema, RPC, persistence, authentication, process, or network
  contract changes are required.
- Living workspace/settings documentation will describe the local-only desktop
  presentation and Windows WSL exception without claiming the underlying remote
  capability was removed.

## Performance and Accessibility

The presentation policy is synchronous and pure. Consumers compute small
derived lists from the already-loaded environment catalog; no polling, network
request, subscription, or duplicate connection owner is introduced.

Hidden controls are not merely visually concealed: they are absent from the DOM
and accessibility tree. Worktree paths remain keyboard-discoverable. Activity
metadata retains readable text order. Focus rings, pointer targets, and minimum
touch sizes must remain complete after the layout changes.

## Alternatives Considered

1. **Recommended and approved: one centralized desktop presentation policy.**
   Every entry point consumes the same runtime/platform decision while remote
   functionality remains intact.
2. Add independent desktop/platform checks inside each component. Rejected
   because entry points can drift and accidentally expose a remote control.
3. Delete or disable remote connection implementations. Rejected because the
   request is presentation-only and browser/hosted functionality must remain.
4. Keep full candidate paths visible and tune font sizes or offsets. Rejected
   because deep paths remain unstable and duplicate the already-visible group
   directory.

## Verification

### Test-driven automated coverage

Implementation begins with failing behavioral tests for:

- the browser, macOS desktop, Linux desktop, and Windows desktop policy matrix;
- Add Project with primary-only, Windows WSL, and hidden remote targets;
- Windows local-only settings, macOS/Linux redirect behavior, and unchanged
  browser/hosted Connections presentation;
- absence of every desktop remote entry point and dialog named in this spec;
- preserved local/WSL retry behavior and inert presentation of saved remote
  projects;
- grouped worktree parent paths, compact candidate labels, full accessible path,
  pinned Add action, duplicate-name discrimination, and narrow-width containment;
- Subagents and Background Tasks metadata inside the title text column; and
- provider action visibility: Claude, Codex, Cursor, and OpenCode visible; Grok
  hidden.

Focused tests run after each behavior change. Broader evidence includes the
complete web tests, desktop compatibility/build checks, `vp check`,
`vp run typecheck`, the workspace package-script test graph, formatting, and
the repository's applicable lint/static gates.

### Packaged v0.3.14 visual review

Build and launch one v0.3.14 desktop bundle from this worktree. Use Codex
Computer Use, not Orca, for UI interaction. Capture original-resolution
screenshots and inspect enlarged pixel crops for:

- discovered worktrees at normal and narrow sidebar widths, including deep and
  duplicate candidate paths;
- expanded Activity Subagents and Background Tasks with running and completed
  rows;
- Add Project with no redundant selector on macOS;
- Settings, sidebar/footer, banners, menus, and dialogs with no remote-device
  affordance;
- provider Settings and action menus with Claude, Codex, Cursor, and OpenCode
  visible and Grok hidden; and
- thread creation, worktree adoption, panel switching, streaming activity, and
  other performance-sensitive UI states previously fixed on the branch.

Pixel review must check horizontal overflow, clipping, ellipsis, icon/text
alignment, action overlap, focus-ring completeness, tooltip placement, stale
remote labels, raw identifiers, and unintended layout movement. Windows WSL
presentation is verified through explicit platform tests and Windows CI because
the packaged visual run occurs on macOS.

## Residual Risk

Native Windows WSL rendering cannot be visually exercised on the macOS host.
Cross-platform policy and component coverage plus Windows CI are the required
evidence for that branch. Saved remote records can still exist and underlying
code can still connect when invoked outside this hidden desktop presentation;
that is intentional for future re-enablement and browser/hosted operation.
