# Provider guides

BiBCode currently supports these coding-agent providers:

| Provider                  | Default state | Native integration        | Activity                                              |
| ------------------------- | ------------- | ------------------------- | ----------------------------------------------------- |
| [Codex](./codex.md)       | Enabled       | Codex App Server JSON-RPC | Structured chat and conditional terminal observation. |
| [Claude](./claude.md)     | Enabled       | Stream-JSON CLI and hooks | Capability-gated chat and terminal observation.       |
| [OpenCode](./opencode.md) | Enabled       | HTTP and server events    | Structured chat and conditional terminal observation. |
| [Cursor](./cursor.md)     | Enabled       | Agent Client Protocol     | Chat; no structured activity in protocol v2.          |

The legacy Grok driver is intentionally not exposed as a supported provider:
it is omitted from Settings and from chat/terminal action menus even if an old
settings payload still contains an enabled Grok entry.

Start with [Provider setup](../getting-started/provider-setup.md) for installation
and authentication commands. Provider CLIs and credentials live on the machine
or remote environment running the BiBCode server, not in the browser client.

Provider instances are configured in Settings. Each instance can select its
binary, environment, display name, and driver-specific options. The server
probes the configured executable and reports installation, authentication, and
model discovery independently; a driver being supported does not guarantee
that its local CLI is installed or ready.

## Updating providers on every environment

When a provider is outdated on any environment, or a connected remote server
has an update available, **Settings → Providers** shows **Provider updates →
Update all…**. The one confirmation lists each connected environment, including
SSH, relay, and direct ones, with the providers it will update and, for a remote
server with an update available, the server version, what restarting it stops,
and how many agents are running there. It names what it skips: providers that
need a manual update or are already updating, servers that must be updated
manually, and environments that are not connected. When nothing can update in
one click, the same reasons show under the action without opening it. Cancel
runs nothing.

After you confirm, at most two environments update at a time, each one's
providers in turn, and one environment's failure never stops another. A remote
server restarts only after its own providers have updated; if one of them
failed or could not be confirmed, that server is skipped and stays as it was.
This action never restarts this desktop app or the server this window is
connected to. The result for each environment's providers and its server
(**Queued**, **Updating…**, **Updated**, still outdated, failed with the
server's message, or skipped) stays in Settings until you choose **Clear**, also
when you leave the page. A step that gets no answer, for example over a
connection that dropped silently, ends as unconfirmed instead of waiting
forever. A server's progress also shows in **Settings → Connections**.

## Skills in chat

The chat menu combines the selected provider's user skills with skills from the
active repository or worktree. User skills outside the repository remain
available even when the repository has no skills. Use `$` for Codex and `/` for
Claude, Cursor, and OpenCode. Each provider's native visibility and name
precedence apply; disabled or non-invocable native skills are not suggestions.

Discovery uses that provider instance's configured home and environment on the
machine running the server. Changing projects, provider settings, or refreshing
providers reloads the relevant catalog. Opening an older menu also refreshes it.
If discovery fails or is incomplete, the menu offers **Retry** and preserves the
draft. Remote environments discover their own user skills.
