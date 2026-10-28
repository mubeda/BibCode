# Left-panel Inbox view (#186): design

Status: approved with changes and implemented. Plan:
[`2026-10-27-inbox.md`](../plans/2026-10-27-inbox.md).

## Approved changes (supersede the sections below where they differ)

- **Row shape** follows the #187 agent-row contract: `AgentGroupId` gains
  `unknown` (counted only under All Agents), rows are per agent with
  `terminalId: string | null` (terminal row key
  `${threadKey}#terminal:${terminalId}`, `ref` = host thread), sessionless
  AI-terminal worktrees get rows, `STATUS_TONES` is exported, and
  `AgentsRow`'s `onJumpToWorkspace` becomes optional (the Inbox omits it). The
  Inbox builds rows with the AI Terminal sources and the status clock, as the
  Agents view does, so a disconnected environment's agents read `offline`.
- **Default tile** is persisted once settled, not held per mount, and only
  from complete data (every environment live with a snapshot and a readable
  catalog): Needs Attention when any agent needs attention, else All Agents.
  Partial data shows the same choice without saving it; loading shows All
  Agents. Partial data shows a note naming its reason: an environment that
  needs attention (degraded, storage changed, recovery required,
  configuration error; its action switches to Environments with it
  selected), a disconnected one, a reconnecting one, or an unreadable
  saved-server catalog.
- **Terminal rows** open `terminal:${terminalId}` through
  `openTerminalPanel`, never by guessing a provider command.
- **Closed host chat**: the new `openHostChat` center-panel action puts
  `chat:host` back into the focused group (an empty layout persists) and
  focuses it.
- **Unread**: `useAgentsUnread` treats the routed thread and the chat panel
  focused in its center layout as open; only chat rows feed the detector.

## Goal

A third left-panel view, **Inbox**, that answers "which agents need me, which
are running, which are finished" without leaving the workspace, and opens the
chosen agent in its worktree.

## UI structure

```
[ Environments | Repositories | Inbox ]   <- SidebarViewToggle, 3 columns
┌──────────────┬──────────────┐
│ All Agents 12│ Needs Att.  2│           <- 2x2 tile grid (role=group)
├──────────────┼──────────────┤
│ Working     3│ Done        7│
└──────────────┴──────────────┘
Needs Attention                            <- list heading = selected tile
  agent row … (most recent first)
  agent row …
──────────
footer (SidebarChromeFooter, unchanged)
```

- **Toggle.** `OPTIONS` gains `{ view: "inbox", label: "Inbox", Icon: InboxIcon }`;
  the grid goes to `grid-cols-3`. Same pattern as today: native buttons in a
  `role="group"` named "Sidebar view", `aria-pressed`, Tab to move,
  Enter/Space to pick, focus ring. The rail-visible minimum content width is
  208px, too narrow for three labelled segments, so the segment's label is
  shown from a container width of about 18rem and hidden below it; the button
  keeps its `aria-label` and gains a `title` so the icon-only form still
  names itself.
- **Rail.** Inbox is cross-environment like the Agents view, so it hides the
  environment rail and the environment context card the same way
  Repositories does (`sidebarView !== "environments"`), and
  `SidebarChromeHeader` reserves the rail strip for both.
- **Body.** `Sidebar.tsx` renders `<SidebarInboxView />` in place of
  `SidebarProjectsContent` when `sidebarView === "inbox"`. The Search row, the
  Agents nav row and the projects list belong to the project views and are not
  shown; the command palette shortcut still works.
- **Tiles.** Four `button`s with `aria-pressed`; exactly one is pressed. Each
  shows an icon, the label and a `tabular-nums` count (`text-xs`, solid
  `text-muted-foreground` when unselected). Accessible name:
  "Needs Attention, 2 agents". Selected tile: `bg-card` + `shadow-xs` +
  `ring-1 ring-ring/40` (the toggle's selected styling plus an outline, so the
  state reads without colour); unselected: `bg-muted/40`, hover `bg-accent`.
  Icons use the existing status tones from `Sidebar.logic.ts` `STATUS_TONES`:

  | Tile | Icon (lucide) | Tone |
  |---|---|---|
  | All Agents | `BotIcon` (same as the Agents nav row) | `text-foreground/70` |
  | Needs Attention | `BellDotIcon` | approval amber |
  | Working | `LoaderIcon` (no spin; motion stays on the row dots) | working sky |
  | Done | `CircleCheckIcon` (done icon, not a dashed review circle) | completed emerald |

- **List.** The rows below are `AgentRow`s rendered with the existing
  `AgentsRow` card (eyebrow project, provider icon, status dot, relative time,
  branch, title, preview line, status · provider · environment badge), inside
  a `data-text-surface="card"` wrapper. One click target per row: clicking
  opens the agent. The row of the agent currently on screen is marked selected
  (`aria-pressed`, the card's active fill).
- **Live updates.** Rows come from the same atoms as the Agents view
  (`useThreadShells`, projects, environments, availability, live branches), so
  counts and lists re-render on every status change with no reload.

## Category mapping (`inbox/inbox.logic.ts`)

Confirmed mapping, one source of truth:

| `InboxCategory` | Label | `AgentGroupId`s |
|---|---|---|
| `all` | All Agents | every row |
| `attention` | Needs Attention | `blocked`, `waiting` |
| `working` | Working | `working` |
| `done` | Done | `done` |

Counts are one pass over the rows. Each list is ordered by most recent
activity (`shell.updatedAt` desc, key as tie-break), matching the order inside
an Agents-view status group; each row's status label already says which state
it is in.

## State and persistence

- `uiStateStore`: `SidebarView` becomes
  `"environments" | "repositories" | "inbox"`; new
  `InboxCategory = "all" | "attention" | "working" | "done"` and
  `inboxCategory: InboxCategory | null` (`null` = never chosen) with a
  `setInboxCategory` action. Both persist in the existing
  `bibcode:ui-state:v1` blob. Parsing accepts exactly the known values;
  anything else becomes `"environments"` / `null`, so old blobs load
  unchanged. An older client reading `"inbox"` falls back to Environments
  (same rule it already applies to unknown values).
- **Default tile (superseded: see "Approved changes" above; the default is
  shown from partial data but saved only from complete data).** While `inboxCategory` is
  `null`, the Inbox picks **Needs Attention** when its count is above 0, else
  **All Agents**. It decides once, after the environment catalog is ready, and
  keeps that pick for as long as the Inbox stays open, so the selection never
  jumps when the last approval is answered. Nothing is written until the user
  clicks a tile; from then on the persisted tile wins on every reload.
  Alternative considered: always open on Needs Attention when it has agents,
  ignoring the persisted tile. Rejected because the brief requires the tile to
  persist, and the Needs Attention count is visible on its tile anyway.
- Before the catalog is ready the list shows **Loading agents…** instead of
  an empty state, so an empty category is never claimed early.

## Opening an agent

Clicking a row: `markRead(row.key)`, `setActiveEnvironmentId(env)` (as the
Agents view's Jump to workspace does), close the sidebar on mobile, then focus
the agent's surface and navigate to `/$environmentId/$threadId` of its
**host** thread. A pure resolver in `inbox.logic.ts` picks the target from the
row and the host's center-panel state:

| Row | Host thread | Surface focused |
|---|---|---|
| Chat panel thread (`shell.kind === "panel"`) | `shell.hostThreadId` | its `chat:<threadId>` surface; added with `openChatPanel` if this client has no tab for it |
| Workspace/default thread whose layout has the host chat | the thread | `chat:host`, activated in the group that holds it |
| Thread whose host chat was replaced by an AI terminal (the "open AI terminal" worktree default) | the thread | the first terminal surface launched with a provider `command` (the AI terminal) |
| Anything else (host chat closed, no AI terminal) | the thread | unchanged layout |

The center-panel store is keyed by the host thread, so focusing runs before
navigation and the route then renders the already-focused surface.

**Terminal-only agents.** `buildAgentRows` lists only threads with a chat
session, so a worktree that runs an AI terminal and never started a chat has
no row today and no status. Rows and status for terminal agents are #187's
scope (it owns `agentsSection.logic.ts` and the status source). When such a
row exists the resolver's AI-terminal branch already opens it; no Inbox change
is needed unless #187 gives a row a specific `terminalId`, in which case the
resolver should prefer that terminal (one-line follow-up).

## Empty states (copy)

| Tile | Empty state |
|---|---|
| All Agents | **No agents yet.** Start a chat in a project and it shows up here. |
| Needs Attention | **Nothing needs you.** Approvals and questions from agents appear here. |
| Working | **No agents are running.** |
| Done | **No finished agents yet.** |

One line of `text-xs text-muted-foreground`, bold first sentence in
`text-foreground/80`. Rows from offline environments stay listed and greyed,
as in the Agents view.

## Unread tracking

`AgentsNavRow` mounts `useAgentsUnread(rows)`, which marks a row unread when
its turn settles while another thread is open. The Inbox view does not render
the nav row, so it mounts `useAgentsUnread` with its own rows; exactly one of
the two is mounted at a time.

## Out of scope

Filter box, grouping menu, unread-only toggle and Mark all read (the full
Agents view keeps them); arrow-key roving focus (the toggle does not have it
today); terminal-agent rows and status (#187).
