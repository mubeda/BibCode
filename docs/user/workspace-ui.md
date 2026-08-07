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

Use the project `+` action to create a worktree. The Create Worktree dialog has a
project selector, Smart/GitHub/Branch/Name modes, an agent picker, advanced
options, a Create more toggle, and Ctrl+Enter submit.

Use Add Project to select a connected host, open one existing project folder,
clone a Git URL, or create a new Git repository. Local and mapped WSL hosts use
the native folder picker; remote and browser-only hosts accept an explicit host
path. Selecting a folder adds that folder as one project and does not scan for
nested repositories.

Workspace row context menus include update/open/copy/pin/unread actions, plus
delete worktree for worktree rows and remove project for primary rows.

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

- Right-click files, folders, or the tree background to create files/folders,
  rename, delete, duplicate, copy paths, add a folder as a project, open in an
  external editor, or open previewable files in the preview browser.
- Open file tabs follow renames and close when their file is deleted.
- Every selected file shows a Save, Undo, and Redo toolbar below its
  breadcrumbs. Markdown files also show their rendered/source toggle in this
  toolbar. While a file is active, edits remain pending until Save or
  Ctrl/Cmd+S is used. Switching to any other right-panel surface or hiding the
  panel saves pending edits in the background. Undo and Redo use independent
  native history for each open source file. Read-only views keep unavailable
  actions visible but disabled.

## Current limitation

- Staged-row diff viewing does not yet use a true `git diff --cached` source.
