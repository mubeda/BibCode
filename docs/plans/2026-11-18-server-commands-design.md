# Server commands: terminal and dashboard per server (issue 378)

Status: implemented on the lane branch for issue 378. The server reserves the
server terminal's thread id; no contract changes. The rest is client-side.

## Decisions

1. **Host.** Each command is a `_chat` route per environment:
   `/environment/$environmentId/terminal` and
   `/environment/$environmentId/dashboard`, like the Pull Requests and
   Pipelines panels. A route gives one panel per server, restore after reload
   (the URL), and close by leaving. Both route bodies are keyed by
   `environmentId`. A restored URL whose server is not registered yet waits
   and then says the server is not available; it never redirects.
2. **Home folder.** `filesystem.browse({ partialPath: "~" })` on the target
   server gives the canonical `directoryPath`, latched for the panel's life.
3. **No chat owner.** `chatThread={false}` hides Add to chat and opens links and
   file previews as a threadless terminal does.
4. **Dashboard.** `useHostDashboard` holds the sheet's subscription and
   presentation; the sheet and the center panel each call it.
5. **Availability.** Both commands need a connected server. They stay visible,
   disabled, with "<server> is not connected." as the reason.

## Server terminal lifecycle

- **Owner.** The server owns one session per environment under the key thread
  `server-terminal`, terminal `server-terminal`. No thread can have that id:
  the engine refuses to create one, and terminal requests on it skip
  workspace admission, so a thread row left from an older server neither
  lends it a workspace nor blocks it. Thread-wide terminal cleanup skips it.
- **Only `terminal.open` creates or replaces the shell.** It reuses a running
  shell and replaces an exited one. No client ever closes the session, so
  there is no close that can race a reopen. The viewport attaches without a
  working directory, so an attach never starts a shell.
- **An exited session** keeps its bounded history (5,000 lines) and no
  process until the next Open terminal replaces it or the server stops, as an
  exited thread terminal does. There is one per server, so nothing reaps it.
- **Process order.** The transcript runtime applies an `exited` event only to
  the process it names, so a late exit of process 1 never marks process 2 as
  exited.

| Event                                                                 | What happens                                                                                              |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Open terminal on a server whose terminal route is current             | Replaces the history entry, so Back leads out of the terminal.                                            |
| Open terminal elsewhere                                               | Pushes the route; the panel runs `terminal.open`, then focuses.                                           |
| Home lookup or `terminal.open` fails, or the open is interrupted      | Toast "Could not open terminal" with the reason, then leave. The next invocation opens again.             |
| `terminal.open` succeeds but input setup fails (`TerminalInputError`) | The shell is confirmed: mount. The viewport prepares input again and shows a failure inside the terminal. |
| The shell exits, in any window                                        | That window leaves. It sends nothing to the server.                                                       |
| Window A's shell exits, window B opens again, A's messages arrive     | A's attach and input reach B's shell or fail; none of them starts, restarts or closes a shell.            |

## Alternatives rejected

- **A new center-panel surface kind in `centerPanelStore`.** That store is keyed
  by a host thread, so a server panel would need a hidden host thread or a
  second store.
- **A hidden per-environment host thread.** It would create orchestration state
  that the sidebar and inbox would have to filter out.
- **Accepting `~` in `terminal.open`, or a home field on the server
  descriptor.** Both need a server change and a fallback for older servers.
- **Attach with `restartIfNotRunning`** to replace an exited shell. Every
  reattach would then restart a shell the user just ended.
- **Closing the exited shell from the client, fenced by its process.** Three
  review rounds found races in it (a late exit, a queued close reaching an
  older server). The exited session costs little and the next open replaces
  it, so the close and its capability are gone.

## Trade-offs

- An older server still accepts a thread named `server-terminal`.
- The browse call lists the home folder's subdirectories; only the path is
  used.
- The packaged suite has only this device, so the Environments view's server
  card is covered by unit tests.
