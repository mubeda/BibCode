# Encyclopedia

This is a living glossary for BiBCode. It explains common terms used in the
codebase and UI.

## Environments And Connections

### Environment

One accepted BiBCode server identity and its host-scoped projects, threads,
terminals, provider runtimes, and diagnostics. Selecting another environment
changes the machine on which those operations run; it never merges local and
remote process, filesystem, or project state.

### Known Environment

The client aggregate for an accepted environment. It contains the durable
environment ID, accepted storage-instance ID, last verified descriptor,
client-local alias/hidden fields, discovery bindings, and connection routes.
The runtime creates one scoped supervisor and at most one active RPC session for
the aggregate.

### Storage Instance

The UUID of the server's persistent database/store. `environmentId` answers
which logical server this is; `storageInstanceId` proves which durable project
store that server currently exposes. A changed non-null storage identity blocks
synchronization until the user explicitly adopts it.

### Binding

A mutable platform locator, such as the desktop primary slot or a WSL distro
name. A binding may remain visible while unavailable, stopped, or awaiting
setup. It is not identity, a route, or authorization.

### Route

One way to reach an environment: desktop loopback, desktop-managed WSL,
desktop-managed SSH tunnel, or direct HTTPS. Routes have stable IDs, priority,
autoconnect/pin metadata, and an optional opaque secret reference. The
supervisor attempts eligible routes sequentially and permits only one to own the
active session.

### Secret Reference

An opaque identifier for a credential or key held by the operating-system
secret provider. Catalog and route rows store the reference, never the secret
value. Renderer storage is not a credential fallback.

### Cache Envelope

An AES-GCM encrypted shell or thread snapshot authenticated to its environment,
storage instance, entity kind, and entity ID. A cache envelope is an offline
rendering aid, never authoritative server state.

### Hide

A reversible client presentation change. It retains the environment's routes,
bindings, credentials, cache, settings, and server-side data.

### Forget

Cancellation-safe removal of one client's environment data. It closes route
admission, cancels and awaits the scoped runtime, deletes protected secret
references, and atomically removes local routes, bindings, UI state, cache, and
environment metadata. It does not imply that a remote server was stopped or
that remote projects/worktrees/data were deleted.

## Project And Workspace

### Project

An environment-local workspace record. A project points at one repository or
workspace root and owns Main plus its ordinary and worktree-backed threads. The
same project ID in another environment is unrelated.

### Workspace Root

The filesystem path for a project checkout. Git, file, terminal, and provider
operations run relative to this root unless a thread has a worktree path.

### Main

The permanent left-panel thread for a project's primary checkout. Main is
stored with wire kind `default`, is always presented as **Main**, and cannot be
renamed, archived, or deleted as an ordinary thread. Selecting the project opens
Main.

### Repository Claim

The environment-local ownership record for one verified Git common-directory
identity. A second add of the same repository family returns the existing
project/Main; an independent clone and the same repository on another
environment receive independent claims and projects.

### Worktree

A Git worktree used as an isolated workspace. Worktree threads have
`worktreePath` set and run chats, terminals, filesystem, and source-control
operations in that path.

### Workspace Thread

A normal visible thread for a project primary checkout or worktree. It owns
conversation history, provider session state, activities, checkpoints, and
workspace metadata.

### Panel Thread

A hidden sibling thread with `kind: "panel"`. Panel threads share the host
thread's project, branch, and worktree but own an isolated provider session and
transcript. They appear as center-panel tabs, not left-panel rows.

## UI Surfaces

### Left Panel

The navigation-only `Environment -> Project -> Main/threads` tree. It shows
status, pin/unread state, context menus, and running-agent adornments. Settings,
diagnostics, conversations, terminals, files, diffs, and panel threads belong
in center workspaces rather than extra left-panel tabs or information panels.

### Center Panel

The main chat and terminal workspace. Center surfaces live in tab groups, with
up to four groups arranged as resizable horizontal or vertical split panes.
Each group has its own active tab; the focused group receives newly created AI
chat and terminal panels. Layout, focus, tab order, and split ratios persist
across reloads.

### Center Surface

A chat or terminal tab inside one center tab group. The host chat represents the
selected workspace thread. Extra chat surfaces use panel threads; closing one
deletes that panel thread. Closing a split pane instead merges its surfaces into
an adjacent group without closing them.

### Right Panel

The tool surface area for the active thread. Its supported surface kinds are
Plan, Diff, Source Control, Files, an individual file, Preview, Terminal, and
Activity. Singleton tools and resource-backed file/browser/terminal tabs share
one ordered, persisted surface rail.

### Source Control

The right-panel Git UI for the active project/worktree. It groups files by
staged, unstaged, and untracked state; exposes stage/unstage/discard/delete
actions; provides commit history and AI commit messages; and drives commit,
pull, push, and PR actions. Its publish control is currently disabled; GitHub
publishing is available from the chat-header Git actions control.

### Files Manager

The right-panel filesystem UI for the active project/worktree. It supports
context menus for files, folders, and background space; create, rename, delete,
duplicate, copy path, add folder as project, external editor, preview, and
explicit Ctrl/Cmd+S saves. Each directory is one expandable row, entries move by
dragging them onto a folder row or the tree root, and Refresh rescans the
workspace on the server so externally created files appear. Expansion state
survives refreshes and mutations.

### Custom Action

A project script/action exposed through the chat header `+` menu and script
commands. Script keybindings use the `script.{id}.run` command shape.

## Orchestration

### Command

A typed request to change domain state, such as creating a project, creating a
thread, starting a turn, or deleting a panel thread.

### Domain Event

A persisted fact that something happened. The server projects domain events
into read models and pushes user-visible updates to clients.

### Projection

A read-optimized view derived from events. Browser clients consume projections
through the WebSocket transport and typed contracts.

### Receipt

A lightweight runtime signal emitted when async work reaches a stable milestone,
such as checkpoint capture, diff finalization, or turn quiescence.

### Quiesced

A turn has gone quiet and stable: provider work and follow-up processing have
settled far enough for tests and orchestration to continue deterministically.

## Provider Runtime

### Provider Driver

The implementation that probes, launches, and translates one backend agent
protocol. BiBCode supports four built-in drivers: Codex, Claude, Cursor, and
OpenCode.

### Provider Instance

A configured provider entry with its own display name, settings, credentials,
home path, environment variables, and model availability. An instance has a
user-facing routing ID and references one provider driver; multiple instances
may use the same driver.

### Session

The live provider-backed runtime attached to a thread. Workspace threads and
panel threads each own their own session.

### Runtime Mode

The safety/access mode for a session. The exact persisted values and UI labels
are `approval-required` (Supervised), `auto-accept-edits` (Auto-accept edits),
and `full-access` (Full access).

### Interaction Mode

The agent interaction style for a session, such as default or plan mode.

### Activity Actor

A provider-observed participant, such as a subagent, shown in the Activity
right-panel surface when the selected provider exposes reliable activity data.

### Activity Work Item

A provider-observed background task or unit of work associated with an activity
actor and thread or terminal scope.

## Checkpointing

### Checkpoint

A saved snapshot of workspace state at a particular turn.

### Checkpoint Baseline

The starting checkpoint used to compute later diffs for a thread timeline.

### Turn Diff

The changed-file summary and patch for one turn.

## Related Docs

- [Workspace UI](../user/workspace-ui.md)
- [Repository layout](./workspace-layout.md)
- [Architecture overview](../architecture/overview.md)
- [Runtime modes](../architecture/runtime-modes.md)
