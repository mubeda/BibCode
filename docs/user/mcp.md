# Outside agents over MCP

An AI agent that BiBCode did not start, such as Claude Code or Codex in a terminal, can
operate a BiBCode environment's threads through MCP. It can start a thread on any provider
and model, send it messages, wait for its turns, answer its questions, interrupt it, and
read its replies and diffs, answer its approvals, and revert it to an earlier checkpoint.

Each BiBCode environment hosts its own MCP server. The agent runs `bibcode mcp` on the host
where that environment's server runs, and that command relays to the server over loopback.

## Set it up

1. In BiBCode, open **Settings → Agents → Agent integrations**. If several environments are
   connected, pick one.
2. Leave **MCP server** on (it is on by default), and choose what **Agents may** do: Read
   only, Supervised (the default), Auto-accept edits, or Full access.
3. Under **Launch command**, use **Copy for Claude Code** or **Copy for Codex** and run the
   copied command in a terminal. It adds an MCP server named `bibcode` to that agent.
4. Restart the agent so it loads the new server.

The copied command already names the right executable, data root and, for a development
build, its dev state. Without the Settings page, register it by hand:

| BiBCode runs as         | Command to add                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| Server on this computer | `claude mcp add bibcode -- bibcode mcp`                                                      |
| A remote host over SSH  | `claude mcp add bibcode -- ssh <host> bibcode mcp`                                           |
| macOS desktop           | `claude mcp add bibcode -- /Applications/BiBCode.app/Contents/MacOS/bibcode-desktop mcp`     |
| Windows desktop         | `claude mcp add bibcode -- "%LOCALAPPDATA%\BiBCode\bibcode-desktop.exe" mcp`                 |
| Linux desktop           | `claude mcp add bibcode -- <path to the AppImage> mcp`                                       |
| WSL environment         | `claude mcp add bibcode -- wsl.exe -d <distro> --exec <server binary> mcp --base-dir <root>` |

For Codex, replace `claude mcp add` with `codex mcp add`. For a data root other than
`~/.bibcode`, add `--base-dir <root>`. To connect with less than the environment allows, add
`--access read-only` (or `approval-required`, `auto-accept-edits`).

Over SSH no tunnel is needed: `bibcode mcp` runs on the remote host and talks to that host's
own loopback server. Remote MCP over HTTP is not supported yet.

## Tools

| Tool                        | What it does                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `list_projects_and_threads` | Projects with their folders, and threads with each thread's status, pending flags, latest turn, provider and model     |
| `list_providers_and_models` | Provider instances with availability, default and custom models                                                        |
| `start_thread`              | Starts a thread in a project with a first prompt and up to 8 attachments (3 MiB in all)                                |
| `send_message`              | Sends a message, with attachments; queued behind a running turn; `mode: "steer"` asks the running turn to take it      |
| `wait_for_thread`           | Waits up to 50 s for the turn to settle or need a person; a timeout never stops the work                               |
| `read_thread`               | The thread's status and a page of messages; long messages and older pages are reachable with `textOffset` and `cursor` |
| `list_pending_requests`     | Open questions and approvals, with each approval's kind, summary and decisions                                         |
| `answer_question`           | Answers an open question                                                                                               |
| `answer_approval`           | Accepts, accepts for the session, declines or cancels a pending approval                                               |
| `interrupt_turn`            | Stops the running turn; when no turn runs it does nothing and says so                                                  |
| `revert_thread_to_turn`     | Restores the files to a turn's checkpoint and rewinds the provider; refused while a turn runs                          |
| `get_turn_diff`             | One turn's patch, paged                                                                                                |
| `git_status`                | Branch, ahead/behind and changed files of the thread's folder                                                          |

Every result is capped at 80,000 characters and says that thread content is untrusted
output from agents and tools. A result cut to fit continues with `nextCursor` (threads) and
`nextProjectCursor` (projects). Mutating tools take an optional `clientRequestId`, so an agent
can retry a call without starting a second turn.

Codex stops a tool call after 60 seconds by default, so one wait lasts at most 50 seconds and
an agent waits longer by calling it again.

### Worktrees

| Tool                        | What it does                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `list_worktrees`            | A project's worktrees with path, branch, availability, primary and locked flags, and the thread that hosts each |
| `create_worktree`           | Creates a worktree (on a new branch with `newBranch`) and its host thread, never above **Agents may**           |
| `get_worktree_removal_plan` | What a removal would lose: uncommitted and untracked counts, locks, and other stale worktrees it would prune    |
| `remove_worktree`           | Removes a worktree and its host thread; destructive                                                             |

`remove_worktree` takes the `planToken` and `generation` the plan returned, so an agent has
read the change counts first, and a worktree that changed since is refused. The token is
opaque and signed by BiBCode: an edited token is refused, and one from before BiBCode restarted
needs a fresh plan. Its modes:

- **`delete`** runs `git worktree remove`. It refuses uncommitted or untracked changes unless
  `discardChanges` is true, which loses them for good.
- **`cleanup`** clears Git's registration of a worktree whose folder is already gone. When
  other stale worktrees would be pruned with it, `confirmRepositoryWidePrune` must be true.
  It is refused when the plan had too many to list in full; remove such a worktree in
  BiBCode, which shows every worktree the prune affects.
- **`detach`** removes the worktree from BiBCode only and keeps the folder and its changes.

A removal finishes in BiBCode even if the agent's call is cancelled, and a retry with the
same `clientRequestId` returns the first result without removing anything again.

### Git

These tools work in the thread's folder (its worktree, else its project's folder), through
the same handlers as the Source Control panel. They belong to the **Source control** set.

| Tool                       | What it does                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `git_stage`                | Stages files or folders                                                                                          |
| `git_unstage`              | Unstages files or folders, keeping their changes                                                                 |
| `git_commit`               | Commits what is staged, running the repository's hooks; no amend and no `--no-verify`                            |
| `git_undo_commit`          | **Destructive.** Removes the last commit when it was never pushed, keeping its changes, and returns its message  |
| `git_revert_commit`        | Adds a commit that reverts another; nothing is lost                                                              |
| `git_push`                 | Pushes a branch; a branch without an upstream is published                                                       |
| `git_force_push`           | **Destructive.** Force-pushes with `--force-with-lease`: refused if the remote moved since the last fetch        |
| `git_fetch`                | Fetches a remote                                                                                                 |
| `git_pull`                 | Pulls the current branch                                                                                         |
| `git_create_branch`        | Creates a branch and switches to it unless `checkout` is false                                                   |
| `git_switch_branch`        | Switches branch; `carryChanges` stashes uncommitted changes or brings them along                                 |
| `git_delete_branch`        | **Destructive.** Deletes a local branch, and with `deleteRemote` its upstream branch too                         |
| `git_delete_remote_branch` | **Destructive.** Deletes a branch on a remote only                                                               |
| `git_discard`              | **Destructive.** Discards changes; files go to the trash unless the trash cannot take them and `permanent` is on |

- **Paths** are literal and relative to the thread's folder, at most 200 per call. A path
  that leaves the folder, directly or through a symlinked folder, and globs or Git pathspec
  magic (`:(glob)…`, `*`, `?`, `[`, `\`) are refused, and so is Git's own metadata (`.git`, in
  any case, or a path that resolves into the Git directory). A file whose name contains one of
  those characters cannot be named over MCP.
- **Retries.** Every tool but `git_stage`, `git_unstage`, `git_fetch`, `git_create_branch`
  and `git_switch_branch` takes a `clientRequestId`. A retry with it returns the first
  call's outcome without running Git again, even after the thread was deleted. If BiBCode
  cannot tell whether the call ran
  (MCP was turned off or read-only mid-push, the agent was revoked, or BiBCode stopped), the
  answer is `McpOutcomeUnknownError`: check `git_status`, then retry with a new id.
- **Deleting a branch with its remote** is two steps. If the remote step fails, the local
  branch is already gone and the answer is `McpPartialOutcomeError`, naming the
  `git_delete_remote_branch` call that finishes it. If the remote step stopped before it
  reported, the partial says `remote: "unknown"`: run `git_fetch` and finish only if the
  remote branch is still there.
- **Results** end with the folder's Git status (`null` once the thread is deleted). A
  refused operation returns its `code` and,
  when a guard refused it, its `blocked` reason, such as uncommitted changes.
- **Discard** lists every file it kept in `trashUnavailable`: one the trash could not take,
  or, with `permanent`, an ignored file that permanent deletion leaves in place. A file whose
  folder is, or turns into, a symlink is kept too, whatever `permanent` says. On macOS and
  Linux, BiBCode first moves each file into a folder of its own in the repository's Git
  directory (`bibcode-discard`), and the trash takes it from there. **Put Back** in the Trash
  therefore does not return a file to the checkout; drag it back instead.

#### Reading history and suggesting a commit message

| Tool                          | What it does                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `git_diff`                    | One file's changes against HEAD as a patch, 16,000 characters a page; `staged` for the index only |
| `git_log`                     | Commits from a branch, tag or sha (HEAD unless set), newest first, paged by `cursor`              |
| `git_refs`                    | Branches with upstream and ahead/behind, remotes, tags, stashes, and any operation in progress    |
| `git_generate_commit_message` | The plain "Update <paths>" line BiBCode would use; nothing is committed                           |
| `git_set_commit_message`      | Suggests a commit message to you in the Source Control panel; it never commits                    |

- **Reads work at Read only.** `git_diff`, `git_log` and `git_refs` change nothing. Their
  text, like every result, is untrusted. `git_diff` needs a `path` (`git_status` lists the
  changed files); a file too large to show returns its size and no content. `git_log` cuts a
  long message at 2,000 characters and a long file list at 50, and says how long each was.
- **A suggested message never replaces your words.** When the box is empty, the message
  fills it with **Message from Agent <name>** under it. When you already typed something,
  you see **Agent <name> suggested a message** with its first line, **Use it** and
  **Dismiss**; **Undo** brings your text back after **Use it**. Once you commit, the same
  suggestion does not come back. BiBCode keeps the last suggestion per folder for 24 hours,
  so a panel you open later still shows it. A message holds at most 8,000 characters.

### Pull requests

These work on the repository of the folder a thread works in, through the provider CLI
(`gh` or `glab`) the **Pull Requests** panel uses. They are in the **Source control** set.

| Tool                  | What it does                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `list_pull_requests`  | A page of pull requests (`open` unless `state` says otherwise), newest first, with branches, checks and review summary |
| `view_pull_request`   | One pull request: state, branches, `headSha`, merge readiness, allowed merge methods, a checks summary, and its body   |
| `pull_request_checks` | Each check's name, state and URL                                                                                       |
| `create_pull_request` | Opens a pull request from the thread's branch, pushing it first, as Source Control's **Create pull request** does      |
| `update_pull_request` | Changes the title, the body or the draft state                                                                         |
| `merge_pull_request`  | Merges, or turns on auto-merge with `auto`; needs the `headSha` the agent read                                         |

- A body is cut at 16,000 characters, with its full length. Bodies and check names are
  untrusted.
- A merge never bypasses branch protection, and is refused when the branch moved since the
  agent read `headSha`. It is marked destructive, so agents that prompt before destructive
  tools prompt for it.
- When a create is cut off and BiBCode cannot tell whether it happened, the agent gets
  `McpOutcomeUnknownError` and should look for the branch's pull request with
  `list_pull_requests` before creating again. When one is already open for the branch, a
  create returns it.
- A merge or update whose provider CLI timed out or lost the host may still have happened,
  so it is `McpOutcomeUnknownError` (`reason: "no-answer"`), never a failure: check
  `view_pull_request` before trying again.
- A retry with the same `clientRequestId` returns the recorded outcome even after the
  thread is deleted.

### Browser preview and devices

An outside agent drives the collaborative browser preview and the server's Android
emulators and iOS simulators with the same tools a provider BiBCode launched uses. Each one
takes a `threadId`, the thread the agent acts for. They are in the **Workspace** set and need
**Agents may** above read-only, the read tools included.

| Tool                                                                                                                     | What it does                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `preview_status`, `preview_snapshot`                                                                                     | The preview's state, and a snapshot of its tab with a screenshot                                  |
| `preview_open`, `preview_navigate`, `preview_resize`, `preview_click`, `preview_type`, `preview_press`, `preview_scroll` | Open, navigate, resize and drive the preview page                                                 |
| `preview_wait_for`, `preview_recording_start`, `preview_recording_stop`                                                  | Wait for something on the page; record the tab                                                    |
| `preview_evaluate`                                                                                                       | **Destructive.** Runs JavaScript in the preview page                                              |
| `device_list`, `device_open`, `device_screenshot`                                                                        | The devices and images, start one and wait for it to boot, and a screenshot at most 1,080 px wide |
| `device_close`                                                                                                           | **Destructive.** Stops a device the thread started                                                |

- **The preview runs in BiBCode.** It needs an open BiBCode window (the desktop app or the
  web UI) for the environment; with none, a call returns
  `PreviewAutomationNoAvailableHostError`.
- **Tabs.** Each agent gets its own preview tab per thread, so two agents, or an agent and the
  thread's own provider, do not take each other's tab.
- **Devices** need **Device previews** on. A device belongs to the thread that started it (a
  chat panel's thread counts as its host's): an agent acting for another thread can see it but
  cannot reuse or stop it.
- Preview pages are untrusted content. Like every result, a preview or device result's text is
  capped at 80,000 characters (a longer one, such as a large `preview_evaluate` value, comes
  back as `truncated` with a note), and hidden or control characters in it are shown as escapes.
  Screenshots come back whole, as images.

### Terminals

A terminal runs any command as the user BiBCode's server runs as, so these tools are off
unless you turn them on. They need all three of:

1. **Terminals** on under **Agents may → What agents can use** (off by default);
2. **Agents may** at **Full access**;
3. an MCP server started after both, so its credential includes terminals. An agent that was
   already connected picks them up only after you restart its MCP server.

Turning **Terminals** off, or lowering **Agents may**, refuses the next call at once.

| Tool              | What it does                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `terminal_list`   | The thread's terminals, yours included: id, label, status and exit code                                   |
| `terminal_open`   | Opens a shell in the thread's folder as a tab in its center panel; it stays open after the agent leaves   |
| `terminal_write`  | **Destructive.** Types up to 16,384 characters into a terminal; returns a `cursor` for reading the output |
| `terminal_read`   | The last 4,000 characters (`tailChars`, up to 16,000), or up to 16,000 written after a `cursor`           |
| `terminal_resize` | Sets a terminal's columns and rows                                                                        |
| `terminal_close`  | **Destructive.** Closes a terminal and ends what runs in it                                               |

- **Your terminals too.** An agent can list, read, type into and close the terminals you
  opened in that thread. What it types is not marked as the agent's. A chat panel's thread
  uses its host thread's terminals.
- **Reading.** `terminal_read` returns `nextCursor`; reading from it returns only newer
  output, and `more` says whether more follows. A terminal keeps about 1 MiB of output, so a
  cursor older than that comes back with `dropped: true` and starts at the oldest output kept.
  Escape sequences are removed unless `raw` is true.
- **Retries.** `terminal_open` and `terminal_write` take a `clientRequestId`, so a retry opens
  one terminal and types once.
- **Privacy.** BiBCode never logs what an agent types or reads, and never puts it in the
  profiler. Terminal output is untrusted content.

### Diagnostics

These read how this environment is doing: the profiler's records, the providers and
hosting CLIs, BiBCode's processes and the server's trace. They are in the **Diagnostics**
set, and all but `refresh_providers` work at read-only.

| Tool                   | What it does                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `profiler_status`      | Whether the profiler records, its disk use and capture capabilities, the newest findings, and the newest crash ids                           |
| `profiler_findings`    | Findings with their evidence: the newest, or with `since` or `cursor` oldest first and paged with `nextCursor`                               |
| `profiler_events`      | Recorded events, newest last, each with its envelope and the fields its kind documents                                                       |
| `profiler_crash`       | One crash record, the events before it, and its stack named from symbols already on the machine                                              |
| `diagnose_environment` | Server version, platform and capability flags; each provider's install, version, status and sign-in state; config issue counts; Git and CLIs |
| `refresh_providers`    | Checks every provider again, as Settings → Providers does, and returns their state                                                           |
| `process_diagnostics`  | BiBCode's processes now and over a window (15 minutes unless `historyWindowMs` says, at most an hour): CPU, memory and attribution           |
| `trace_diagnostics`    | Trace counts, log counts per level, and the most frequent, slowest and failing spans by name                                                 |

- **Projections, not redaction.** Each result is built from named fields.
  `diagnose_environment`, `refresh_providers`, `process_diagnostics` and `trace_diagnostics`
  return no prompt, message, command line, log line, failure cause, path, setting or account.
  The profiler tools return the profiler's own records cut to their documented fields: a
  finding keeps its kind, counts, times and its kind's evidence, without `title` or
  `summary`; an event keeps its envelope and its kind's fields, and an undocumented kind only
  its envelope. A client's id comes back as an opaque `h…` value, keyed with a secret the
  server draws at start, that matches across records until the server restarts; its
  correlation id and version are left out. A worktree path is kept only inside home (`~/…`),
  and a source location, crash module or stack frame keeps a relative path or its file name.
  A panic's message is never returned, in its event, its `crash.panic` finding or a crash's
  earlier events: it can still name a file. Its kind, thread, location and frames are.
- **Catching up on findings.** `profiler_findings { since }` (inclusive) returns findings
  oldest first by `lastSeen`; follow `nextCursor` until it is null. A finding that recurs
  later comes again with its new `lastSeen` and `count`, even within the same second, and a
  finding written into the second a page ended in comes on the next page. A page shrinks to
  fit beside its cursor, and a finding too large to return alone comes with
  `evidenceOmitted: true`. Up to 1,000 findings are kept.
- The profiler tools read the profiler's directory whether recording is on or off. Without a
  profiler runtime they return `McpProfilerUnavailableError`.
- `profiler_symbolicate` and symbol downloads stay on `bibcode profiler mcp`, and the server
  log and the diagnostics bundle stay in the app.

### What changed, and this server

These two belong to no set: they are always listed and work at read-only.

| Tool                  | What it does                                                                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server_capabilities` | Server version, MCP protocol versions, `toolsVersion`, the agent's effective ceiling, the sets that are on, its scopes, and every error type with what it means and what fixes it |
| `changes_since`       | What changed since a cursor, as ids and states only, from BiBCode's event log and the agent activity log                                                                          |

- **`toolsVersion`** is a hash of the tools this agent can see now. When it changes (a set
  turned off, a lower ceiling), list the tools again.
- **Errors.** Every failure is a tool result with an error type (`_tag`), such as
  `McpServerDisabledError`, `McpCapabilityDisabledError`, `McpScopeError`, `McpBusyError`,
  `McpOutcomeUnknownError`, `idempotency_conflict` or `McpPartialOutcomeError`.
  `server_capabilities` lists them all. Through `bibcode mcp`, a revoked credential is
  `McpCredentialRefusedError` and a server that stopped is `McpServerUnreachableError`; a
  remote HTTP client gets a 401 for a refused credential.
- **Following changes.** Call `changes_since` once without a cursor: it returns where the
  logs are now and no entries. Pass each call's `cursor` to the next, and call again at once
  while `more` is true. An entry is `{ cursor, at, kind, threadId, status, requestId,
  actor }`, never text:
  - `thread.created`, `panel.created`, `thread.archived`;
  - `turn.requested`, `turn.started`, `turn.completed`, `turn.interrupted`, `turn.failed`,
    and `session.status` for any other change of the session's status;
  - `approval.requested`, `approval.resolved`, `input.requested`, `input.resolved`
    (`status` is `resolved` or `expired`), each with its `requestId` when the provider's id
    is a plain id (letters, digits, `_`, `.`, `:`, `-`, at most 128); otherwise
    `list_pending_requests` names it;
  - `agent.call` for each change an outside agent made through MCP, with its `tool`, its
    outcome as `status`, and a `target` of ids (a commit, a pull request number, a file
    count).
- **Nothing is missed.** Both logs are on disk and page by id, so a cursor still works after
  a reconnect or a restart. One call scans at most 5,000 events, and fewer when their
  payloads are large, and returns its position even when none matched. `threadId` keeps one thread's changes; use one cursor per filter.
  Agent activity is kept for 7 days or 5,000 rows: an older cursor sets `activityDropped`.
- **Not in the feed:** Git operations a person ran in the app, worktree and file changes, and
  profiler findings, which `profiler_findings` pages with its own cursor.

### Chat panels and UI suggestions

A chat panel is a second thread beside a host thread, in the same folder, shown as a tab in
every BiBCode window. These tools are in the **Workspace** set; only `list_chat_panels` works
at read-only.

| Tool                 | What it does                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `create_chat_panel`  | Opens a panel on a host thread, never above **Agents may**; a retry with the same `clientRequestId` returns it again |
| `list_chat_panels`   | A host thread's open panels, with each one's status, model, mode and the agent that opened it                        |
| `send_panel_message` | Sends a message from one thread of a worktree to another, and the message shows where it came from                   |
| `focus_ui`           | Suggests what you might look at: a thread, its files or one file, its Source Control panel, or its diff              |

- **Panel messages stay in one worktree.** `send_panel_message` goes between a host thread
  and its panels, or between two panels of one host; anything else is
  `McpNotSameWorktreeError`. The message shows **From <panel title>** beside the agent's
  chip, and `read_thread` returns its `sourceThreadId`. BiBCode accepts that origin only on
  an agent's panel message from a thread that agent opened or last sent a message to, so
  no one can speak as another agent's panel (`McpSourceThreadNotOwnedError`). With
  `includeLastReply`, the
  source thread's last reply is quoted after the text, at most 16,000 characters of it.
- **Suggestions never move anything.** `focus_ui` raises a small notice in every BiBCode
  window showing the environment, **Agent <name> wants to show <what>**, with **Show**.
  Nothing changes until you click it, so a suggestion never takes focus while you type.
  A notice goes away after 60 seconds, a window that was hidden shows it when you come back
  if it is still pending, and at most 16 may wait per thread and 64 per agent. The result
  says how many
  windows were watching. `path` is a file relative to the thread's folder, for `files` and
  `diff` only.
- A panel an agent opened carries an **Agent** badge on its tab; its tooltip names the agent
  and the reason it gave (`purpose`).

### Clone

An agent can clone a repository into the folder that holds one of your projects, beside
it, and add the clone as a project. These tools are in the **Workspace** set.

| Tool               | What it does                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `clone_repository` | Clones an `https://` URL beside the project `parentProjectId` names and adds it as a project (`addAsProject`)   |
| `clone_status`     | How a clone this connection started is going: `running`, the finished folder and project, or why it failed      |
| `cancel_clone`     | Stops a clone this connection started and removes its folder; a clone you started that the agent joined goes on |

- **HTTPS from public hosts only.** The URL must start with `https://`, with no user name or
  token in it. SSH, `host:path`, `git://`, `file://` and other transports are refused, and so
  is any host that does not resolve to a public internet address. Clone those in BiBCode
  yourself: your own clones are unchanged. The address BiBCode checked is the one Git
  connects to, and a repository that redirects elsewhere fails with a message naming the
  redirect; clone the address it moved to.
- **Your Git settings do not apply.** An agent's clone ignores your global and system Git
  configuration (rewrites, credentials, proxies, hooks, filters and URL-specific settings)
  and any proxy in the environment, so it reaches only public repositories directly. On a
  network that allows the internet only through a proxy, clone in BiBCode yourself.
- **No Git LFS downloads.** LFS files stay pointer files, because a repository's
  `.lfsconfig` could point the download at any host. Run `git lfs pull` in the clone
  yourself if you want them.
- **Long clones.** `clone_repository` waits up to 50 seconds, then returns `state: running`
  with its `cloneId`, and the clone goes on; `clone_status` reads it later. Without a
  `clientRequestId`, BiBCode makes one, and that is the `cloneId`.
- **Stopping.** Turning the MCP server off, **Read only**, revoking the agent, **Stop**,
  **Take over** and `cancel_clone` stop the agent's clone and remove the folder it made. A
  clone stopped while Git ran is `unknown`, since Git may have finished at that moment.
- **Again.** A finished clone of the same URL already in the folder is reused, not cloned
  again, and a folder that is already a project gives that project, never a second one. A
  folder holding anything else is refused and left as it is.
- Git 2.37 or later is needed on the server.

### Files

These work with the files in a thread's folder (its worktree, else its project's folder), as
the Files panel does. They are in the **Files** set, which is on by default; the list, search,
read and download tools work at read-only.

| Tool             | What it does                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `files_list`     | Files and folders in the thread's folder, at most 200 (`limit`)                                              |
| `files_search`   | Files and folders whose path matches `query`, best first                                                     |
| `files_read`     | A text file in pages of up to 16,000 characters from `offset`, with the whole file's `version`               |
| `files_write`    | Replaces a text file (at most 1 MiB), given the `version` it read or `createOnly`                            |
| `files_create`   | Creates an empty file or a folder                                                                            |
| `files_rename`   | Renames or moves a file or folder; refused when the target exists                                            |
| `files_delete`   | **Destructive.** Moves a file or folder to the system trash, or deletes it with `permanent: true`            |
| `files_download` | A URL that downloads a file, or a folder as a zip, with GET                                                  |
| `files_upload`   | **Destructive** with `overwrite`. A URL that takes one file's bytes as a POST body and writes it in a folder |

- **Paths stay inside.** Paths are literal and relative to the thread's folder: `..`, an
  absolute path, a glob or pathspec character, and a symlinked folder that leads outside are
  refused. Each operation reaches the file through a folder handle opened without following
  symlinks, so a folder swapped for a symlink after the check is refused too.
- **No lost edits.** `files_write` needs the `version` `files_read` returned, or `createOnly`
  for a new file. A file changed since is refused (`file_changed_on_disk`); read it again. A
  file over 1 MiB, or a binary one, cannot be read or written here: download it.
- **Delete goes to the trash.** If the trash cannot take an entry, it is left in place
  (`trash_unavailable`); nothing falls back to a permanent delete. `files_delete` takes a
  `clientRequestId`.
- **Transfers.** No file bytes pass through MCP. A transfer URL works for 5 minutes, for one
  file or folder, and only while the agent's access lasts: Stop, Revoke, turning the MCP
  server or **Files** off, or (for an upload) **Take over** or read-only ends it, also
  mid-transfer, and an upload cut off this way leaves nothing behind. An upload URL created
  without `overwrite` never replaces a file. Each transfer an agent's URL ran is listed in
  **Agent activity** when it ends. The URL is this computer's address, so an agent connected
  with `ssh <host> bibcode mcp` cannot reach it and should copy the file with `scp`.

### Who acted, Stop and Take over

BiBCode marks what an outside agent does, whoever is looking:

- **Agent · <name>** marks each message an agent sent, each thread or worktree it created
  (the reason it gave, `purpose`, is in the tooltip), and each Source Control commit a recent
  agent call made. The name is the agent's **Authorized clients** label when it acted.
  `start_thread` and `create_worktree` take an optional `purpose` of at most 200 characters.
  `read_thread` returns each message's `actor` (and `sourceThreadId` for a panel message)
  and the thread's `requester`.
- **The status bar** shows **Agent active · <name>** while an agent has made a call in the last
  two minutes, still has work running, or has a turn running that it started, with two
  buttons:
  - **Stop** revokes the agent, which ends its calls and the Git and pull request work it
    started, and interrupts each running turn it started. Your own turns, a compaction you
    started included, are left alone. Stop also works on an agent you already revoked whose
    turns still run. If a turn cannot be interrupted, or interrupting takes longer than ten
    seconds, BiBCode says so; stop that turn from its thread.
  - **Take over** makes the agent read only: it can still read, every change it asks for is
    refused, and work it started stops. **Hand back** restores exactly the access it had.
- **Settings → Agents → Agent integrations → Agents** lists each authorized agent with its
  last call, tools and access, with **Take over** (or **Hand back**) and **Revoke**, and
  **Stop** while it has turns running (a revoked agent with running turns is listed as
  **Revoked**, with Stop). Below it, **Agent activity** shows what agents changed in the last
  seven days, newest first, as ids and counts only (a commit, a pull request number, a file
  count), never paths, messages or output.
- Revoke, unlike Stop, leaves running turns alone. None of these asks for confirmation: each
  only stops an agent, and reconnecting or **Hand back** undoes it.
- You can see and use these from the computer that runs the environment (the desktop app,
  or a browser session that may manage access), as for **Authorized clients**.

## From a shell: `bibcode thread`

`bibcode thread` calls the same tools from a terminal or a script. It runs on the host where
the server runs (the desktop app's executable takes it as `<desktop exe> thread`, like
`mcp`), finds the server and signs in as `bibcode mcp` does, and revokes its credential
when it exits. While it runs it shows as one **CLI · bibcode thread** row in **Authorized
clients**.

| Command                                    | What it does                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `bibcode thread list`                      | Projects with their folders, and their threads with each status              |
| `bibcode thread start <project> <message>` | Starts a thread; `.` is the project whose folder holds the current directory |
| `bibcode thread send <thread> <message>`   | Sends a message; it queues behind a running turn and never interrupts it     |
| `bibcode thread show <thread>`             | The thread's status and its latest messages                                  |

- Pass `-` as the message to read it from standard input.
- `start` takes `--title`, `--provider <instance>` and `--model`. Without them it uses the
  project's default model, else the Default Agent's.
- `--wait` (on `start` and `send`) waits until the turn settles or needs a person, in
  30-second calls of `wait_for_thread`, and prints the reply. Stopping it with Ctrl-C stops
  only the waiting: the turn goes on.
- `--json` prints one JSON document. For `start` and `send` it is
  `{ "threadId", "messageId", "status", "reply", "requestId", "error" }`, also on failure.
- `start` and `send` take `--request-id <id>` (1 to 256 characters); without it one is made
  up and printed as `requestId`. If a run is interrupted, or loses BiBCode before it hears
  back, it may already have started the thread or sent the message. It prints the id and
  the hint "Run the same command with --request-id <id> to finish it without repeating it."
  Run that exact command, with the same message and options: BiBCode returns the original
  thread and message instead of starting or sending again, for 24 hours. The same id with
  anything else changed is refused as `idempotency_conflict`.
- `list` and `start .` read every page of projects and threads (up to 50 pages), so a long
  list never hides the project that holds the current directory.
- `--base-dir <root>` picks another data root, as for `bibcode mcp`.

It exits 0 on success, 1 on a failure or a turn that ended interrupted, failed or
undelivered, and 2 when the thread waits on a person (an approval or a question): answer it
in BiBCode. With **MCP server** off it exits 1 with the same message as `bibcode mcp`.

```sh
bibcode thread start . "Summarize the README" --wait
echo "Now list the open TODOs" | bibcode thread send <thread id> - --wait --json
```

## What it can and cannot do

- **Access.** A thread an agent starts never runs above **Agents may**, and an agent cannot
  message or answer a thread that runs above it. Lowering the setting applies at once to
  connected agents. Raising it reaches an agent only after its MCP server restarts.
- **Approvals.** A Supervised thread stops at its first approval, and whoever drives it may
  answer: you in BiBCode, or the agent with `answer_approval`. An agent may accept only on a
  thread at or below **Agents may**; it may decline or cancel on any thread.
- **Not available.** There are no tools for worktree removal, discard, undo, revert,
  delete, force-push, settings, credentials, the updater, pairing or relay.
- **Credential.** `bibcode mcp` signs in with its own credential, limited to reading and
  operating threads, and only on `/mcp`. It lives only in that process's memory, never in a
  command line, file or log, and is revoked when the agent stops the MCP server. Each
  running agent shows as one **MCP · <agent name>** row in **Authorized clients**.

## Turning it off, and revoking one agent

- **Turn off MCP server** to stop every outside agent on that environment at once. `bibcode
  mcp` then refuses to start, calls in progress end, and calls get a "turned off" error.
  Nothing is revoked, so turning it back on works with no new setup. A provider's own
  browser preview and device tools keep working.
- **Revoke** one agent's row in **Authorized clients** to stop only that agent. It then asks
  you to restart its MCP server, which signs in again.
- **Stop** and **Take over** (see [Who acted](#who-acted-stop-and-take-over)) stop one agent
  from any screen.

## Troubleshooting

| Message                                                                    | Cause                                                       | Fix                                                         |
| -------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| "The MCP server is turned off for this environment."                       | MCP server is off                                           | Turn it on in Settings → Agents → Agent integrations        |
| "No BiBCode server with MCP support is running on this data root."         | BiBCode is not running, is older, or uses another data root | Start or update BiBCode; pass `--base-dir` for another root |
| "This BiBCode server does not listen on this computer's loopback address." | The server binds only to another interface                  | Bind it to a loopback or wildcard address                   |
| "The program listening on … is not this BiBCode server."                   | Another program took the recorded port, or BiBCode crashed  | Start BiBCode again                                         |
| "BiBCode ended this MCP connection's access."                              | The agent's row was revoked                                 | Restart the MCP server in the agent                         |
| `--access … is above this environment's limit`                             | Asked for more than Agents may                              | Raise Agents may, or ask for less                           |

When two BiBCode servers run on the same data root, such as the desktop app and a
`bibcode serve` on another port, `bibcode mcp` reaches the one that started first. The
other logs that MCP discovery stays with the running server. Stop the first one and
restart the other to move discovery to it.

A Windows update ends a desktop-hosted `mcp` process along with the app; restart the MCP
server in the agent afterwards.
