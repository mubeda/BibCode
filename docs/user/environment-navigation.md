# Environment Navigation

BiBCode organizes work by the machine that owns it:

```text
Environment
└── Project
    ├── Main
    └── Threads and worktree threads
```

An environment is one accepted BiBCode server identity. Its projects, paths,
processes, provider sessions, terminals, Git state, and diagnostics exist on
that server. Projects from two environments are never merged just because they
use the same Git repository. Within one environment, adding the same Git
common-directory identity again selects the existing project and Main instead
of creating a duplicate. An independent clone remains a different project.

## Left navigation

The left panel is a single navigation tree. Environment rows are level 1,
project rows are level 2, and Main plus ordinary or worktree-backed threads are
flat level-3 siblings. There is no extra Worktrees level and there are no
settings tabs or information panels in the sidebar.

Main is the permanent thread for the project's primary checkout. Selecting a
project opens Main. Main cannot be renamed, archived, or removed separately;
removing it means removing the project. Worktree threads keep the existing
worktree creation, discovery, adoption, missing-path, dirty, lock, detach, and
safe-removal behavior.

Search matches environment aliases, projects, paths, branches, Main, and
thread titles. A matching descendant keeps its environment and project
ancestors visible so ownership is never ambiguous. Status changes do not move
rows. Manual environment order remains stable, pinned environments are
presentational, and hidden environments can be restored from **Settings →
Environments**.

Every status is expressed in text as well as color. Current states include
**Online**, **Connecting**, **Reconnecting**, **Offline**,
**Authentication required**, **Version incompatible**, **Updating**,
**Stopped**, and **Setup required**. Cached project rows remain visible while
an environment reconnects or is blocked. Offline data is read-only: BiBCode
does not queue a project, thread, Git, filesystem, terminal, or provider write
to run later. A successful live snapshot is required before an empty project
list becomes authoritative.

## Keyboard and assistive technology

The sidebar exposes one virtualized ARIA tree. Use:

- Up/Down to move through visible rows;
- Right to expand a row or move to its first child;
- Left to collapse a row or move to its parent;
- Home/End to move to the first or last visible row;
- character keys for type-ahead;
- Enter or Space to activate the focused row;
- Shift+F10 to open the row context menu; and
- Escape to clear search.

Focus and selection are separate, visible states. Virtualized rows retain
logical level, position, set size, and stable identity for screen readers.
Menus and status text do not depend on hover or color. The tree, center tabs,
warnings, and confirmations must remain usable at 200% zoom, narrow window
widths, and with reduced motion enabled.

## Environment center workspace

Open an environment row's action to manage it in the center workspace. The
available tabs are **Overview**, **Connection**, **Service**, **Security**,
**Projects & Storage**, **Updates**, **Diagnostics**, and **Platform**.
Availability depends on the route and trusted host-authority channel. The
header owns the client-local alias, pin, and manual order controls. Environment
settings do not appear in the left panel.

Use **Add environment** to enroll a route:

- **This device** is the permanent primary environment.
- **WSL** appears on Windows. Every Running distribution is discovered; one
  without a verified compatible server says **Setup required**. An accepted
  Stopped distribution remains in the hierarchy, while an unaccepted stopped
  distribution stays in Add environment. BiBCode never starts or unregisters
  a distribution automatically.
- **SSH** enrolls Linux, macOS, or Windows OpenSSH hosts through a
  desktop-owned loopback tunnel and explicit setup consent.
- **Direct HTTPS** accepts only `https://` or `wss://`, with system trust or an
  explicit certificate pin. Non-loopback HTTP has no override.

See [Remote access](./remote-access.md) for transport and provisioning details.

## Disconnect, hide, and remove

Open the environment's center removal workspace before changing its lifecycle:

- **Disconnect** stops this client's active session. Routes, credentials,
  cache, settings, and remote data remain.
- **Hide** changes only local presentation and is reversible. It does not stop
  the runtime or remove credentials, cache, projects, worktrees, or settings.
- **Remove from this client** (the internal operation is called Forget) drains
  this client's scoped runtime and removes its local routes, secret references,
  bindings, cache, UI state, and environment metadata in a crash-recoverable
  order. It does not prove that anything was removed from the remote host.
- **Force remove from this client** is available when the environment is
  offline. The user must type the environment alias and explicitly acknowledge
  that the remote result is unknown. The server, service, projects, worktrees,
  credentials, and data may remain. No remote operation is queued for later.

Remote server uninstall and remote data deletion are separate, optional host
administration choices. The UI describes uninstall as preserving the data root
and recommends keeping data. These choices remain disabled until BiBCode has a
fresh, versioned removal plan and a trusted desktop, local-control, or SSH
host-authority adapter. Remote data deletion must additionally enumerate the
affected storage identity, projects, worktrees, running processes, and other
paired clients and require exact typed confirmation. Local removal and remote
cleanup report separate outcomes; an unknown remote outcome is never shown as
success.

The primary environment cannot be hidden, forgotten, remotely uninstalled, or
purged from this workspace.
