# Outside agents over MCP

An AI agent that BiBCode did not start, such as Claude Code or Codex in a terminal, can
operate a BiBCode environment's threads through MCP. It can start a thread on any provider
and model, send it messages, wait for its turns, answer its questions, interrupt it, and
read its replies and diffs. A person still answers every approval in BiBCode.

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

| Tool                        | What it does                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `list_projects_and_threads` | Projects and threads with each thread's status, pending flags, latest turn, provider and model                    |
| `list_providers_and_models` | Provider instances with availability, default and custom models                                                   |
| `start_thread`              | Starts a thread in a project with a first prompt                                                                  |
| `send_message`              | Sends a message; queued behind a running turn, never interrupts; `mode: "steer"` asks the running turn to take it |
| `wait_for_thread`           | Waits up to 50 s for the turn to settle or need a person; a timeout never stops the work                          |
| `read_thread`               | A page of messages; long messages and older pages are reachable with `textOffset` and `cursor`                    |
| `list_pending_requests`     | Open questions and approvals                                                                                      |
| `answer_question`           | Answers an open question                                                                                          |
| `interrupt_turn`            | Stops a running turn                                                                                              |
| `get_turn_diff`             | One turn's patch, paged                                                                                           |
| `git_status`                | Branch, ahead/behind and changed files of the thread's folder                                                     |

Every result is capped at 80,000 characters and says that thread content is untrusted
output from agents and tools. Mutating tools take an optional `clientRequestId`, so an agent
can retry a call without starting a second turn.

Codex stops a tool call after 60 seconds by default, so one wait lasts at most 50 seconds and
an agent waits longer by calling it again.

## What it can and cannot do

- **Access.** A thread an agent starts never runs above **Agents may**, and an agent cannot
  message or answer a thread that runs above it. Lowering the setting applies at once to
  connected agents. Raising it reaches an agent only after its MCP server restarts.
- **Approvals.** An agent never answers an approval. A Supervised thread stops at its first
  approval until you answer it in BiBCode; the agent sees `awaiting_approval` and can tell
  you.
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
