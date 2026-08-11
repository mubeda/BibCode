# Project Data Recovery Visual Blockers

**Date:** 2026-08-11

## Context

Packaged macOS testing through Codex Computer Use reproduced two safety gaps in
the current project-data protection flow.

First, the sidebar's **Use this data location** action calls the WebView's raw
`window.confirm`. In the packaged Tauri application no confirmation was shown;
the accepted storage identity changed immediately. The application already has
a typed `LocalApi.dialogs.confirm` boundary which invokes the native Tauri
dialog and uses `window.confirm` only for a browser host.

Second, a malformed `environment-id` marker correctly prevents SQLite startup
and preserves the marker and database bytes, but the renderer shows only a
generic authentication HTTP 500. A primary backend launch plan is published to
`BackendSupervisor` only after successful startup. On a persistence failure the
host records an error without retaining the plan, so privileged project-data
inspection has no authoritative target. The recovery coordinator also learns
about automatic recovery only from a registered client environment, which a
failed primary backend can never create.

## Goals

- Require a visible, cancellable native confirmation before desktop storage
  identity adoption.
- Preserve browser confirmation behavior through the existing local API.
- Retain the authoritative launch plan when a desktop backend fails to start.
- Automatically inspect and open recovery for a typed local
  `recovery-required` startup failure, including malformed markers.
- Close the race between renderer startup, backend failure, and bridge event
  subscription without polling SQLite.
- Keep Rust inspection as the source of truth and preserve fail-closed database
  behavior.
- Re-run the isolated packaged application through Codex Computer Use and
  inspect screenshots at original pixel resolution.

## Non-goals

- Inferring recovery from HTTP status codes or error-message text.
- Letting the renderer supply a filesystem path or storage identifier.
- Changing offline restore or start-empty semantics.
- Adding T4Code discovery, migration, compatibility, or aliases.
- Automatically adopting, merging, deleting, or replacing a store.
- Making remote bearer, relay, or SSH environments eligible for local desktop
  recovery.

## Design

### Storage-adoption confirmation

`Sidebar` will resolve the existing `LocalApi` and call
`api.dialogs.confirm` with the current non-merge warning. Adoption starts only
after that promise resolves `true`. A missing local API, `false`, or rejected
confirmation performs no accepted-identity transition and schedules no retry.

The desktop implementation continues through `DesktopBridge.confirm` and the
registered `desktop_bridge_confirm` Tauri command, which owns the native
`OkCancel` dialog. Browser mode retains the local API's explicit
`window.confirm` fallback. The sidebar will not call `window.confirm`
directly.

### Failed backend target retention

`BackendSupervisor` will retain the exact `BackendLaunchPlan` for a primary
start attempt that fails after planning. The slot remains non-running, keeps
the failure detail, and keeps any typed WSL plan error required by settings.
It does not publish a bootstrap, bearer credential, endpoint, or live backend.

The retained plan is sufficient for `project_data_targets` to resolve the
native data root or the already validated WSL data root. Privileged inspection
therefore uses the same host-owned plan that startup attempted. Planning
failures that never produced a valid plan remain unavailable and are not
invented in the renderer.

### Typed status-change notification

After a default backend startup failure is recorded, the Tauri host emits a
`desktop:project-data-status-changed` event containing only the stable logical
environment identifier. The event does not contain paths, raw errors,
credentials, or a claimed recovery classification.

`DesktopBridge` exposes an additive optional subscription for this event. The
event is only an invalidation signal: after receiving it, the renderer calls
`getProjectDataStatuses`, whose Rust inspection result remains authoritative.
Older hosts simply omit the optional subscription.

### Automatic recovery coordination

`ProjectDataRecoveryCoordinator` performs one read-only project-data status
probe when the current desktop bridge becomes available. It also repeats that
probe after each project-data status-change event. This closes both event
orders:

1. if backend failure is recorded before the renderer subscribes, the mount
   probe sees the retained target;
2. if the renderer probes before backend failure, the later event triggers the
   authoritative inspection.

Only a returned local status with `status: "recovery-required"` becomes an
automatic recovery candidate. Existing shell-derived recovery status remains
supported. The coordinator deduplicates one open per environment episode and
resets the episode after the environment is no longer recovery-required.
Remote environments cannot enter this bridge-owned status list.

Probe failures remain non-destructive and do not replace the router error with
an invented recovery state. The existing generic error remains available when
the host cannot establish that recovery is required.

## Data Flow

1. The desktop host resolves an authoritative native or WSL launch plan.
2. Store preparation fails closed, for example on a malformed marker.
3. `BackendSupervisor` retains the failed plan without publishing a live
   bootstrap.
4. The host emits the project-data status-change invalidation event.
5. The recovery coordinator's mount probe or event callback invokes the
   privileged status command.
6. Rust resolves the retained plan and classifies the selected store.
7. A typed `recovery-required` result opens the existing recovery dialog over
   the router error surface.
8. Retry, restore, start-empty, path opening, and diagnostic export continue
   through their existing privileged commands.

Storage identity adoption remains separate: the user clicks **Use this data
location**, accepts the native confirmation, and only then does the client
catalog conditionally transition the exact blocked identity and retry.

## Failure, Race, and Security Behavior

- No project-data event payload is trusted as a classification result.
- A healthy or unavailable inspection never opens recovery automatically.
- A failed or cancelled confirmation performs no adoption.
- A failed native confirmation performs no adoption and may be surfaced through
  existing UI error handling without falling back to a second desktop prompt.
- Retaining a failed plan does not expose a bootstrap or mark the backend live.
- Mount probing plus event invalidation closes the subscribe-before/after-fail
  race without a timer or repeated database inspection.
- Existing runtime and storage-operation locks continue to protect inspection
  and recovery. No normal SQLite mutation is added.
- Requested/effective roots remain available only in the privileged recovery
  status and are not added to ordinary environment descriptors or event
  payloads.

## Testing

RED-to-GREEN behavioral coverage will prove:

- sidebar cancellation makes zero adoption calls and uses the local API rather
  than raw `window.confirm`;
- sidebar confirmation performs exactly one adoption call;
- a failed primary start retains the exact launch plan but publishes no live
  bootstrap;
- the host emits the bounded project-data status-change payload after startup
  failure;
- the Tauri adapter forwards and disposes the optional subscription;
- a mount-time recovery-required status opens automatic recovery;
- failure after the mount probe opens recovery through the event path;
- healthy, unavailable, and remote states do not open local recovery;
- duplicate notifications do not repeatedly open one recovery episode.

Broader verification will include affected web, contracts, desktop, server
persistence, and project-data safety targets; package/workspace typechecking;
`vp check`; Rust formatting and Clippy with warnings denied; and final diff and
status review.

The final packaged macOS retest will use an isolated custom bundle and
`BIBCODE_HOME`. Codex Computer Use will verify the native adoption dialog's
cancel and confirm branches, force a malformed marker, verify automatic
recovery presentation, exercise Retry and Start empty cancellation, compare
marker/database hashes, and inspect original-resolution screenshots. Windows
and Linux packaged behavior remains CI/runtime evidence until corresponding
artifacts are available.
