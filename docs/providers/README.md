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
