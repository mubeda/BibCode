# Environments

An environment is one BiBCode server identity and its owned filesystem,
projects, worktrees, provider processes, terminals, settings, and diagnostics.
The application hierarchy is:

```text
Environment
└── Project
    ├── Main
    └── ordinary and worktree threads
```

The left panel is navigation only. Select an environment to open its settings,
status, connection, service, security, storage, updates, diagnostics, and
platform tabs in the center workspace. BiBCode does not add settings tabs or
informational panels to the left sidebar.

## Project ownership

A project belongs to exactly one environment. The same Git repository on two
environments is two independent projects because the databases, files,
provider processes, and worktrees are different. Within one environment, the
same Git common-directory family cannot be added twice: selecting its primary
checkout or a linked worktree returns the existing project and permanent
**Main** thread. An independent clone is a separate project.

Every project has exactly one **Main** for its primary checkout. Main cannot be
renamed, archived, or deleted on its own. Ordinary threads and worktree-backed
threads are flat siblings beneath it. Existing worktree discovery, adoption,
locking, dirty-state checks, retargeting, detach, and safe-removal behavior is
preserved and remains owned by the server environment.

## Add an environment

- **This device** is the permanent desktop-owned primary environment.
- **WSL** is offered on Windows. Running distributions are discovered and
  shown automatically. Setup is explicit. A previously accepted Stopped
  distribution remains visible as unavailable; an unaccepted stopped
  distribution stays in **Add environment**. BiBCode never starts or
  unregisters a distribution automatically.
- **SSH** supports Linux, macOS, and Windows OpenSSH hosts. The desktop verifies
  host-key policy, probes the host, asks before installation, and terminates the
  remote loopback listener behind a desktop-owned loopback tunnel.
- **Direct HTTPS** enrolls an existing `https://` or `wss://` endpoint with
  system trust or an explicitly confirmed SPKI pin. Plain non-loopback HTTP has
  no override.

Server installation and client pairing are separate. Pairing credentials are
shown once, expire after five minutes, and grant the fixed full-administrator
scope. There are no permission tiers yet. A successful enrollment binds both
the environment UUID and storage-instance UUID; a later mismatch blocks before
project/session synchronization.

## Status, search, and offline behavior

Rows retain stable manual order while status changes. Search matches aliases,
project names and paths, branches, Main, and thread titles while keeping owning
ancestors visible. Text accompanies every status color. Important states are
**Online**, **Connecting**, **Reconnecting**, **Offline**,
**Authentication required**, **Version incompatible**, **Updating**,
**Stopped**, and **Setup required**.

Verified cached rows remain visible offline. Offline data is read-only: project,
thread, Git, filesystem, terminal, provider, settings, and removal writes are
never queued for a later reconnect. An empty project result is authoritative
only after a successful live snapshot.

## Disconnect, hide, and removal

- **Disconnect** closes the active client session. Routes, credentials, cache,
  settings, service, and server data remain.
- **Hide** is a reversible local presentation choice. Restore it from
  **Settings -> Environments**.
- **Remove from this client** drains this client's runtime and removes its
  local routes, secret references, bindings, cache, UI state, and catalog
  record. It does not prove any remote server or data was removed.
- **Force remove from this client** is an offline escape hatch. The UI asks for
  the exact environment alias and a second acknowledgement that the remote
  result is unknown. The service, projects, worktrees, credentials, and data
  may remain, and no cleanup is queued for later.

Online removal offers remote server uninstall and full data purge as separate,
unchecked choices. Uninstall preserves the data root and is recommended when
cleanup is uncertain. Native MSI, PKG, DEB, and RPM uninstallers remain owned
by the operating system; BiBCode does not pretend a service-only removal
removed the package. Purge is irreversible, requires zero projects,
worktrees, and owned processes, and requires the exact environment alias again.
Local removal and remote cleanup report independent outcomes.

The primary environment cannot be hidden, forgotten, remotely uninstalled, or
purged from this workspace.

For exact controls, accessibility, and tree behavior, read
[Environment navigation](./environment-navigation.md). For enrollment and
transport troubleshooting, read [Remote access](./remote-access.md). For host
operations, read [Server administration](../operations/server-administration.md).
