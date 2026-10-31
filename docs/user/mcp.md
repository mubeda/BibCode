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
read the change counts first, and a worktree that changed since is refused. Its modes:

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
  magic (`:(glob)…`, `*`, `?`, `[`, `\`) are refused. A file whose name contains one of
  those characters cannot be named over MCP.
- **Retries.** Every tool but `git_stage`, `git_unstage`, `git_fetch`, `git_create_branch`
  and `git_switch_branch` takes a `clientRequestId`. A retry with it returns the first
  call's outcome without running Git again. If BiBCode cannot tell whether the call ran
  (MCP was turned off or read-only mid-push, the agent was revoked, or BiBCode stopped), the
  answer is `McpOutcomeUnknownError`: check `git_status`, then retry with a new id.
- **Deleting a branch with its remote** is two steps. If the remote step fails, the local
  branch is already gone and the answer is `McpPartialOutcomeError`, naming the
  `git_delete_remote_branch` call that finishes it. If the remote step stopped before it
  reported, the partial says `remote: "unknown"`: run `git_fetch` and finish only if the
  remote branch is still there.
- **Results** end with the folder's Git status. A refused operation returns its `code` and,
  when a guard refused it, its `blocked` reason, such as uncommitted changes.

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
