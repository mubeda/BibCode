# Product And UX Specification

## Product Contract

BiBCode presents execution ownership explicitly. A project row is meaningful
only beneath its owning environment. Every command opened from a project or
thread resolves to that environment before it reaches client runtime or RPC.

The left panel is a navigation tree. Detailed content, settings, diagnostics,
terminals, files, diffs, conversations, and extra chat panels belong in the
center workspace.

## Information Architecture

```text
Environment (server identity and health)
└── Project (one environment-local repository/workspace root)
    ├── Main (permanent primary-checkout workspace thread)
    ├── Ordinary workspace thread
    └── Worktree-backed workspace thread

Center workspace only
└── Panel threads and other center surfaces/tabs
```

The tree must not create a fourth Worktrees level. A worktree is an execution
context owned by a workspace thread, not a project or environment.

## Environment Rows

Every non-hidden environment has one root row containing:

- Disclosure caret.
- Platform/status icon with non-color status text when not healthy.
- Client-local alias, falling back to the canonical server label.
- Optional concise condition badge such as Stopped, Setup required,
  Reconnecting, or Offline.
- Context menu.

Interaction is intentionally split:

- Caret or Left/Right Arrow controls expansion.
- Selecting the name selects the environment and opens its center overview.
- Context menu exposes connect/reconnect, hide, fully remove, and only the
  platform actions supported by that environment.

The primary native machine is always present and uses the same row model. Its
permanence does not grant permission to purge host data without the same
destructive flow.

## Expansion And Ordering

On first use or first discovery, only the selected environment, project, and
thread path expands. BiBCode then persists and restores every manual expansion
choice per client.

Default environment ordering is:

1. Explicitly pinned/manual order.
2. Primary native machine.
3. Running WSL distributions.
4. Connected remote environments.
5. Offline and stopped environments.

After a row is placed, transient status changes do not move it. Manual ordering
and pinning are client-local settings.

Inside a project, Main remains first. Ordinary workspace threads precede
worktree-backed workspace threads; each group retains the current stable
pin/order behavior. Worktree, unread, attention, and running-agent information
remain compact row adornments rather than new navigation levels.

## Selection And Startup

The client persists a scoped selection:

```text
environmentId + optional projectId + optional threadId
```

At cold start:

1. Load catalog, preferences, collapse state, and encrypted cached shell data.
2. Render the exact last selection without waiting for the network.
3. Start route supervisors and reconcile server state.
4. Keep the selected row if it is offline, stopped, reconnecting, or temporarily
   absent from a stale discovery result.
5. Fall back only when the selected entity was explicitly forgotten/deleted or
   an authoritative online snapshot proves it no longer exists.

Fallback order after explicit removal is nearest surviving parent, then Main of
the next project, then the environment overview, then the primary environment.

## Project Add And Uniqueness UX

The server resolves Git identity before project creation. If the verified local
Git common-directory/worktree family already belongs to an active project:

- Return the existing project and Main thread as an idempotent result.
- Navigate to that project in the current environment.
- Show “Already added in this environment.” as an informational notice.
- Do not create a project, ordinary thread, worktree, or compatibility alias.

An independent clone with a different local common directory is allowed even
when its remote URL matches another project.

Project creation is not visible until both project and permanent Main exist.
If the atomic command fails, neither row may appear.

## Thread Presentation

- Main is always labeled `Main`; it cannot be renamed, archived, or removed as
  an ordinary thread.
- Selecting a project opens Main.
- Ordinary workspace threads have a conversation icon.
- Worktree-backed workspace threads have a worktree icon and optional branch
  label; current discovery, adoption, missing-path, dirty, locked, detach, and
  Git-removal flows are retained.
- Panel threads continue to appear as tabs/surfaces in the center workspace and
  never appear as duplicate left-panel rows.

## Search

The left-panel search covers visible:

- Environment alias and canonical label.
- Project title.
- Thread title.
- Repository/workspace path.
- Worktree path and branch.

Each result retains its environment and project ancestors, including when only
a descendant matches. Search never flattens matching threads into a global
repository group. Hidden environments are searched only from the Hidden
Environments settings surface.

Search supports keyboard type-ahead, Up/Down navigation, Enter to activate, and
Escape to clear. Large result sets use the same flattened tree/virtualization
pipeline as the normal tree without losing `aria-level`, `aria-setsize`, or
`aria-posinset` information.

## Environment Status Model

The UI uses actionable status rather than a generic Error state:

| State                   | Meaning                                                       | Primary action                       |
| ----------------------- | ------------------------------------------------------------- | ------------------------------------ |
| Online                  | Verified active route and compatible server                   | Open content                         |
| Connecting              | Initial route attempt within its deadline                     | Cancel or wait                       |
| Reconnecting            | Previously connected; bounded retry/backoff active            | Retry now                            |
| Offline                 | No verified route currently succeeds                          | Inspect cache or reconnect           |
| Authentication required | Transport succeeded; client credentials are absent/rejected   | Pair again                           |
| Version incompatible    | Identity succeeded; protocol/capability ranges do not overlap | Update client/server                 |
| Updating                | Server admitted an update and is draining/restarting          | View progress                        |
| Stopped                 | Previously added WSL distro is installed but not running      | Start externally/open WSL management |

`Setup required` is a provisioning condition for a discovered host/WSL distro,
not a generic transport error.

Projects and threads retain their own activity, unread, approval, input,
running, archived, missing-worktree, and failure states. An offline environment
subdues its cached descendants but does not overwrite their last-known domain
state with a fabricated error.

Status must be communicated by icon/text and accessible name, never color
alone. Healthy rows may use a concise green dot; every exceptional state has a
text label.

## Offline UX

When an environment becomes offline:

- Preserve its cached project/thread rows and expansion state.
- Keep recent cached thread content openable in read-only mode.
- Display “Offline · last synchronized …” and mark cached content stale.
- Disable mutations with a nearby reason, for example “Reconnect to create a
  thread.”
- Never queue hidden turns, project mutations, Git actions, terminal launches,
  worktree operations, settings changes, uninstall, or purge for later replay.
- Reconcile through the normal authoritative snapshot/event flow after a route
  proves the accepted identities again.

If metadata exists but thread content is not cached, show the row and “Content
unavailable offline.” Do not imply an empty conversation.

## Environment Center Workspace

Selecting an environment opens a stable settings destination. It contains:

### Overview

- Client alias and canonical server/host label.
- Durable environment UUID and accepted storage-instance UUID.
- OS, architecture, server/protocol version, capabilities, status, and last
  identity verification.
- Project/thread counts and current route summary.

### Connection

- Ordered routes, active route, explicit pin, autoconnect, last success/failure,
  SSH host configuration, HTTPS endpoint, certificate trust/fingerprint, and
  route identity verification.
- Add, verify, reconnect, edit non-secret route data, and remove route actions.
- Pair-again action when credentials are absent or rejected.

### Service

- Workstation/headless mode, startup mechanism, service account, binary and
  data paths, bind/port, process/service health, and local control channel.
- Start/stop/restart, install, and uninstall when the current client has the
  required host authority.

### Security

- Paired administrator clients, DPoP key fingerprint, client label/platform,
  issued/last-connected timestamps, and revoke action.
- TLS status and pinned/system trust source.
- No permission-level editor in this release.

### Projects And Storage

- Project/workspace inventory, database/storage identity, data path, size,
  backup health, export/restore, and separately guarded purge.

### Updates

- Installed/latest compatible version, stable channel, manual update, opt-in
  unattended updates, last result, and binary rollback state.

### Diagnostics

- Local bounded/redacted health and logs, explicit export, and privacy notice.
- No upload, telemetry, analytics, crash-report submission, or usage reporting.

### Platform Details

- WSL: distro name, default marker, WSL version, running/stopped, server setup,
  and systemd availability when relevant.
- Windows: logon task or service state/account and firewall/bind posture.
- macOS: LaunchAgent/LaunchDaemon state, user approval, and signing/notarization
  status.
- Linux: systemd user/system unit and linger state.

Client-owned preferences remain editable offline. Server-owned fields are
read-only cache while offline. Host-owned controls are enabled only through a
local `DesktopBridge`, local control CLI, or explicit SSH administration path;
otherwise they show why the action is unavailable.

## Hide, Forget, Remove, Uninstall, And Purge

UI language must expose consequences before confirmation:

| Action               | Client metadata                             | Client secrets/cache | Remote service        | Remote data       |
| -------------------- | ------------------------------------------- | -------------------- | --------------------- | ----------------- |
| Disconnect           | Keep                                        | Keep                 | Keep                  | Keep              |
| Hide                 | Keep; mark hidden                           | Keep                 | Keep                  | Keep              |
| Forget               | Delete                                      | Delete               | Keep                  | Keep              |
| Uninstall server     | Keep until outcome; then Forget is optional | User choice          | Delete binary/service | Preserve          |
| Purge remote data    | Remove after verified success               | Delete               | User choice           | Delete            |
| Force remove offline | Delete                                      | Delete               | Unknown/untouched     | Unknown/untouched |

The row menu offers Hide and Fully remove, not a misleading Disconnect label for
catalog deletion.

### Hide

Explain that Hide is reversible and retains credentials, cache, routes, and
settings. Provide a link to Settings → Environments → Hidden.

### Fully Remove While Online

The consequence wizard asks independently:

1. Remove this environment from the current client (required).
2. Uninstall remote BiBCode Server (optional and unchecked).
3. Delete remote BiBCode data/projects/worktrees (optional, unchecked, visually
   destructive, and followed by typed environment-name confirmation).

Keep-data is the default. The final confirmation restates each selected effect.
The server returns a versioned removal plan before executing uninstall/purge;
stale plans require review again.

### Force Remove While Offline

Uninstall and purge are unavailable because BiBCode cannot verify or execute
them. Offer Force remove from this client only after warning that:

- Remote server, projects, worktrees, and data remain.
- The remote server may keep running.
- Other paired clients remain paired.
- Re-adding requires pairing again.
- Manual host cleanup may still be necessary.

Require the environment alias to be typed before local secrets, routes, cache,
and metadata are cleared. Never queue uninstall/purge for reconnection.

## WSL-Specific UX

- Automatically add every currently running distro as a platform-managed row.
- Show running distros lacking a compatible server as Setup required; install
  and upgrade require explicit consent.
- Keep previously added stopped distros visible as Stopped.
- List other installed/stopped distros in Add Environment without starting them.
- Permit the desktop to start/stop BiBCode Server inside an already-running
  distro.
- Provide Hide, Reset client connection data, Stop BiBCode Server, and Open
  Windows WSL management.
- Never expose or call unregister/delete-distribution functionality.

## Accessibility And Scale

The component is a single-select navigation tree following the WAI-ARIA Tree
View pattern:

- `tree`, `group`, and `treeitem` semantics with accurate expanded/selected
  state.
- Focus and selection are visually distinct.
- Up/Down moves visible focus; Right expands/moves to first child; Left
  collapses/moves to parent; Home/End and type-ahead are supported.
- Enter selects/opens the center destination; the caret also has a separately
  named pointer target.
- Context-menu keyboard access and screen-reader labels include environment,
  project, status, and thread/worktree role.
- Status and destructive warnings are not color-only.
- Navigation-to-center focus behavior is deliberate and tested.

The flattened visible-tree selector must avoid cross-environment joins on every
render. Derivations are memoized per environment, expensive status reads remain
server-owned, and large trees may virtualize rows while retaining keyboard and
ARIA set metadata. Acceptance testing covers at least 100 environments and
1,000 visible rows without connection-status-induced reordering or input lag.

## Required UI States

Implementation and native visual runbooks cover:

- First run with only primary.
- Multiple online environments.
- Running WSL setup required.
- Stopped WSL.
- Connecting and reconnecting.
- Offline with complete cache, metadata-only cache, and no cache.
- Authentication required.
- Version incompatible.
- Updating/restarting.
- Environment/storage identity mismatch.
- Empty environment and project.
- Duplicate repository add.
- Search across online/offline descendants.
- Hidden environment restoration.
- Online full removal and offline force removal.
- Route failover success and all-routes-failed.
- Large tree, keyboard-only, screen reader, reduced motion, and narrow width.

See [approved mockups](./left-panel-mockups.md).
