# Workspace UI

BiBCode is split into left, center, and right work areas. The left panel chooses
the project/worktree thread, the center panel runs chats and terminals, and the
right panel hosts project tools.

## Left Panel

Projects are shown as groups of workspace rows:

- The primary row represents the project's live checkout. Its branch label is
  refreshed from the checkout, not from a stale thread title.
- The primary row is backed by an undeletable default thread. Attempts to delete
  it should guide the user to remove the project instead.
- Worktree rows represent eager worktree threads. Creating a worktree creates
  both the Git worktree and its thread before the first message.
- Rows can show pinned/unread state and nested agent activity such as provider,
  running state, and elapsed time.

The sidebar says **No projects yet** only after every configured environment
has connected and returned a successful empty project snapshot. During startup,
reconnects, unavailable environments, storage-location changes, or recovery
conditions it shows that availability state instead. Cached project rows stay
visible during those conditions and are replaced only after a newly accepted
environment completes synchronization.

Use the project `+` action to create a worktree. The Create Worktree dialog has a
permanent Name field, an optional Smart/GitHub/Branch **Create From** selector,
an agent picker, advanced options, a Create more toggle, and Ctrl+Enter submit.
Selecting a free local branch suggests its name and enables **Reuse branch** by
default; edited names are preserved, and branches already checked out elsewhere
continue through the server's safe suffixed-branch flow. Typing an exact local
or remote branch selects that ref without repeating the same value as a result
row below the input. If the chosen remote branch becomes local before submit,
the server reuses it when free and still suffixes it when another worktree owns
it.

Use Add Project to open one existing project folder, clone a Git URL, or create
a new Git repository. On macOS and Linux desktop, Add Project uses this device
and omits a redundant location selector. On Windows, it shows **Location** when
a mapped WSL backend is available, offering **This device** and the usable WSL
locations. Browser clients retain connected-host selection. Local and mapped
WSL locations use the native folder picker; browser-only remote hosts accept an
explicit host path. Selecting a folder adds that folder as one project and does
not scan for nested repositories.

Workspace row context menus include update/open/copy/pin/unread actions, plus
delete worktree for worktree rows and remove project for primary rows. On the
local desktop environment, **Open in → File Explorer** opens the repository
folder for a primary row or the worktree folder for a worktree row. The action
is omitted for remote environments and browser mode.

### Discovering existing worktrees

When a connected server advertises worktree-catalog support, BiBCode can show
Git worktrees that already belong to a project repository but have no workspace
row. New projects start with discovery hidden. The first authoritative result
offers **Add**, **Add all**, or **Keep hidden**; the project menu can later
switch between hidden and shown discovery. A hidden acknowledged result is a
compact `Hiding N` summary, while shown results appear as dashed discovered
rows grouped by connected environment and project.

Adding a discovered row adopts that exact server-observed candidate as an
ordinary workspace. It does not create a Git worktree and does not run the
project's worktree-creation script. Concurrent clicks converge on the same
workspace. Discovered rows are grouped beneath their parent directory and use
compact branch or detached-HEAD labels. When labels would otherwise duplicate,
the row adds its final path component as a discriminator. The full host path is
available in a tooltip and accessible name; the compact row copy is separately
keyboard-focusable. The client submits only the project, opaque catalog key,
generation, and command data; the server rechecks the path and repository.

Catalog controls are absent for servers without the capability. Active
catalogs refresh after reconnect and when the window regains focus or becomes
visible. If an observation is degraded, the UI keeps the last authoritative
rows instead of treating them as deleted.

### Missing and removing worktrees

An adopted worktree that is authoritatively missing remains selectable. Its row
shows the branch, host path, registration/lock context, a warning, and actions
to retry verification or remove it. The same warning and disabled filesystem
work apply to all chat panels hosted by that workspace. A temporary Git,
permission, or probe failure is shown as verification unavailable and does not
claim that the directory is missing.

Removal always begins by loading a fresh server plan. For a present worktree the
dialog offers exactly these outcomes: cancel, remove the workspace from
BiBCode, or delete the Git worktree and remove it from BiBCode. Dirty changes
and stale-registration prune impact require separate confirmations. If the plan
changes before execution, the dialog requires review again.

For an already missing worktree, BiBCode may offer verified cleanup of its stale
Git registration before detaching. Cleanup failure is reported as a partial
outcome while the workspace can still be removed from BiBCode. A failed
deletion of a present worktree leaves the workspace attached. Removal requests
contain IDs, the plan token and generation, the selected mode, and confirmation
flags—not a filesystem path.
Deleting a worktree closes its workspace and linked-panel terminals under a
server-held fence before filesystem cleanup begins. Selecting a stale row while
deletion is in progress cannot reopen a terminal into that checkout. If an
external process still uses the worktree as its current directory, deletion
fails before removing files; close that process and retry the same row. If Git
removal succeeds but deleting the sidebar row fails, retrying that stale row is
safe even when a new worktree has since reused the old folder.

## Center Panel

The active thread's main chat starts as the first center tab. It can be reordered,
moved between split panes, or closed from the center layout without deleting the
thread. While present, it remains mounted throughout layout and tab changes. The
chat header `+` menu contains:

- enabled AI providers, which create new chat panels
- Open Terminal, which creates a shell terminal panel in the current worktree
- enabled provider terminal actions, which launch the selected provider CLI in
  the current worktree using that provider instance's configured binary path
- Add custom action, which opens the custom action dialog

Each extra chat panel is an isolated AI session. For contributors, this is
implemented as a hidden sibling thread with `kind: "panel"` that shares the host
thread's project, branch, and worktree. Panel threads are hidden from the left
panel and are deleted when their tab closes.

Tabs persist across reloads. The host chat remains mounted while another center
tab is active, so its transcript, scroll state, and composer state are preserved.

Only the focused center pane may programmatically focus its terminal. Moving
focus to a chat pane leaves visible terminals mounted but prevents them from
reclaiming keyboard input until the user explicitly activates a terminal again.

Use `Cmd+J` on macOS or `Ctrl+J` elsewhere to create and focus a terminal tab in
the focused center pane. When a center terminal owns focus, `Cmd/Ctrl+N` creates
another terminal tab, `Cmd/Ctrl+D` creates a terminal in a new right-hand center
split, `Cmd/Ctrl+Shift+D` creates one in a new lower center split, and
`Cmd/Ctrl+W` closes the focused terminal. Closing the final tab in a split
collapses the empty pane. Infeasible splits, including attempts beyond the
four-pane limit or below the minimum pane size, show a notice without opening a
terminal session.

Project script actions run in a visible center terminal. They reuse the focused
idle center terminal when possible and otherwise open a new center terminal.
The retired bottom terminal drawer and its bottom-toolbar toggle no longer
exist.

### Composer context window

In the normal composer footer, controls remain visible in this order: MCP
status, context-window usage, then send or stop. Both status controls are
capability gated by the selected provider instance:

| Provider         | MCP-status control | Context-window control |
| ---------------- | ------------------ | ---------------------- |
| Codex            | Supported          | Supported              |
| Claude           | Supported          | Supported              |
| Cursor           | Disabled           | Disabled               |
| Grok             | Disabled           | Disabled               |
| OpenCode         | Disabled           | Disabled               |
| Other or unknown | Disabled           | Disabled               |

Disabled providers still show the corresponding control with an unavailable
tooltip, but the control cannot open a status popover. Stale activity does not
override the selected provider's capability.

For Claude, the MCP popover starts with the status reported during session
initialization and refreshes after successful provider responses. It preserves
the last valid snapshot if a refresh is unavailable.

A supported provider with no valid reading shows an awaiting-data popover until
the first provider response. Once measured, the meter's popover shows active
usage, the maximum when known, and lifetime processed tokens when supplied.
Usage above 90 percent is presented as a warning through the meter's red
treatment. Automatic-compaction support is stated when the provider reports it.

The access and reasoning controls remain icon-only in the composer toolbar.
When Full Access is selected, its lock icon is red in both the toolbar and the
access menu. When the selected reasoning level is the highest level advertised
by the active provider and model, the toolbar's reasoning bars and the selected
level title in the menu are red; lower levels remain neutral.

While a provider turn is active, the timeline shows a reversed paint-and-fade
dotted square followed by `Waiting for` and a whole-second elapsed timer, such
as `Waiting for 3s`. The timer is anchored to the persisted user-message time
after reload and never moves backward when the provider start time arrives.
The animation uses the current theme's muted foreground and becomes static when
reduced motion is requested. A later pending delivery queued behind an
unresolved failed or uncertain delivery does not appear active; resolve the
earlier delivery's Retry/Dismiss notice before the queued message can run. The
composer remains blocked and offers `Cancel queued message` so queued work can
be withdrawn before resolving the older delivery.

Question and approval composer footers retain their specialized controls and do
not gain the normal context-window control.

Center tabs can be arranged into as many as four visible split panes. Drag a tab
within its strip to reorder it, into another pane to move it, or onto a pane edge
to create a left, right, upper, or lower split. The tab context menu offers the
same four moves. Each pane has its own active tab; the focused pane owns the
center creation actions, so new chats and terminals open there.

Drag pane dividers to resize them. Layout, focus, tab order, and split ratios
persist across reloads. Closing a split pane merges its tabs into the adjacent
layout without closing chats or terminals. Explicit tab close commands remain
pane-local and do close their underlying panel thread or terminal session.

## Right Panel

The right panel hosts persistent tool surfaces for the active thread. Use its
`+` menu to add Browser, Terminal, Files, Diff, or Source Control. Activity and
Plan surfaces can also appear when the active provider/session supplies them.

- **Browser** opens a local application preview or URL when the environment
  supports previewing.
- **Terminal** starts a shell in the active workspace.
- **Diff** reviews branch or worktree changes.
- **Activity** shows structured provider activity when available.
- **Plan** displays the active agent plan when available.

### Activity and targeted Stop

Activity combines provider-attributed observation with capability-gated
control. The dock shows one provider icon for the active scope; each Subagents
row shows one provider icon for its actor. Active and Done counts are the only
multiplicity signal: they are primary row content, while elapsed time is
secondary metadata aligned beneath the section title. The same Activity
presentation is used in the inline right panel and its responsive sheet.

Activity record details format Started, Ended, and event instants using the
user's timestamp preference. The exact canonical RFC 3339 value remains
available in the semantic time metadata and hover tooltip.

Subagents follow the canonical actor hierarchy, using indentation and a
connector for a visible parent. Missing, invalid, cyclic, or otherwise unusable
parentage safely renders the actor as a root rather than inventing a hierarchy.
In a structured-chat **Subagents** roster, an active actor shows a persistent
trailing action only while the current provider runtime has proved a current
admitted control target for that actor. The row and action are separate
keyboard-focusable controls: the row opens detail, while the action acts
immediately and does not open detail. Its accessible label and tooltip name the
actor and the number of currently active child agents included in the subtree.
An active actor without a current exact provider target keeps its observed
**Running** lifecycle and shows read-only **Stop unavailable** in the action
column. That label performs no RPC and is distinct from server-authoritative
**Stopping**; it makes restart or target-retirement state explicit without
inventing cancellation authority.

**Stop subtree** targets the selected actor and every attributable descendant
in its canonical subtree; **Stop** targets an actor with no active descendants.
Neither targets the actor's parent, siblings, root chat, unrelated work, or an
Activity-enabled terminal. Unsupported and terminal actors have no action. The
composer Stop remains the separate root-turn action.

After admission, every currently covered active actor shows **Stopping** and
its action is disabled. This label is server-authoritative intent, not a
completed lifecycle: the row moves to Done only after provider events report a
terminal state. If dispatch finishes with active residuals, the panel reports
the bounded remaining count and offers **Retry remaining**. Retry is constrained
by the server to residuals and late descendants under the original cancellation
fence; it cannot expand to a parent, sibling, or replacement provider runtime.
An operation that still has active residuals ten seconds after admission becomes
partial even if provider delivery returned without a terminal lifecycle event,
so the UI cannot remain on **Stopping** indefinitely.
Reconnect restores the current server's control state, while a server restart
requires the new runtime to prove exact targets again.

Right-panel terminals retain their internal terminal grouping and splitting.
When a right-panel terminal owns focus, the terminal new, split right, split
down, and close shortcuts operate within that right-panel terminal surface;
`Cmd/Ctrl+J` still creates a center terminal.

### Source Control

The Source Control panel is Orca-parity for the shipped local Git workflow:

- The primary action is adaptive. With staged files it defaults to Commit. With
  only unstaged or untracked files it becomes Stage All Changes. Clean-tree
  states then move through pull, push, and PR actions when available. Publish is
  currently shown disabled in this right-panel surface; the separate GitHub
  publish flow lives in the chat-header Git actions control.
- The dropdown is always rendered and disables unavailable actions instead of
  hiding them.
- Files are grouped into staged, unstaged, and untracked sections with status
  badges.
- Per-file hover actions support stage, unstage, discard, restore deleted files,
  and delete untracked files. Destructive actions require confirmation.
- Row context menus provide view, copy path, copy relative path, open in external
  editor, ignore file name, and ignore parent folder when the corresponding host
  actions are available.
- Commit history and AI commit-message generation are available in the panel.
- Successful saves from the built-in file editor notify active Source Control
  subscriptions immediately. Periodic status polling remains a fallback for
  changes made by external tools.

Stash and amend are intentionally not present; this matches the Orca reference
behavior for this pass.

### Files

The Files surface is a full file manager for the active workspace:

- Every directory is its own row with its own expand arrow. A folder whose only
  child is another folder is not merged into a single combined row, so each row
  names exactly one directory.
- Git-ignored files and directory roots remain visible with ignored styling,
  and the contents below an ignored directory are loaded eagerly with the rest
  of the tree.
- Right-click files, folders, or the tree background to create files/folders,
  rename, delete, duplicate, copy paths, add a folder as a project, open in an
  external editor, or open previewable files in the preview browser.
- **New File…** and **New Folder…** create the entry in the clicked folder. On a
  file row they use that file's parent directory, and on the tree background
  they use the workspace root.
- Drag one or more files and folders onto a folder row, or onto the tree's root
  area, to move them there. Entries already in the target folder stay put. A
  move the server rejects is reported and the tree resyncs to the server's state
  rather than keeping the dragged row in its new place. Dragging is disabled
  while the workspace is unavailable. If availability changes during a drag,
  the optimistic move is likewise resynced instead of remaining on screen.
  Dragging entries to or from the operating system's file manager is not
  supported.
- Open file tabs follow renames and moves, and close when their file is deleted.
- The tree follows changes made outside BiBCode. While the Files surface is open,
  the server watches the workspace and the tree picks up files and folders
  created, renamed, or removed by other tools within a few seconds. Editing a
  file's contents outside BiBCode does not change the tree, because the tree
  lists paths rather than contents.
- The panel header offers collapse all folders, expand all folders, search, and
  Refresh. **Refresh** rescans the workspace on the server immediately, rather
  than waiting for the next check. The tree background context menu offers the
  same Refresh. While that rescan is pending the action is disabled and labelled
  **Refreshing…**; repeated requests share that same rescan. A server or
  transport failure is reported and the existing tree remains available after
  its query is reconciled.
- Saves to built-in Git classification controls such as `.gitignore` and files
  under `.git` automatically rescan the tree. If the repository configures an
  arbitrary custom `core.excludesFile`, editing that custom file is not detected
  from the current cache; use **Refresh** after changing it. Saving content to
  an existing ordinary file keeps the cached path list, while creating a file or
  parent folder rebuilds it.
- Expanded folders stay expanded. Refreshing, and creating, renaming, deleting,
  duplicating, or moving an entry, does not collapse the tree.
- Every selected file shows a Save, Undo, and Redo toolbar below its
  breadcrumbs. Markdown files also show their rendered/source toggle in this
  toolbar. While a file is active, edits remain pending until Save or
  Ctrl/Cmd+S is used. Switching to any other right-panel surface or hiding the
  panel saves pending edits in the background. Undo and Redo use independent
  native history for each open source file. Read-only views keep unavailable
  actions visible but disabled.

## Current limitations

- Staged-row diff viewing does not yet use a true `git diff --cached` source.
- Outside changes are detected by a periodic check, so the tree updates within
  seconds rather than instantly. Use Refresh when you want it immediately.
- Changes to an arbitrary custom Git `core.excludesFile` require **Refresh**;
  automatic classification-control provenance is not yet cached.
- File mutations validate the workspace-relative target before the later
  path-based filesystem call; they do not yet use an anchored, no-follow handle.
  A dangling symlink or concurrently rebound ancestor can therefore race that
  validation. Do not mutate a workspace whose path topology is controlled by
  untrusted concurrent software.
