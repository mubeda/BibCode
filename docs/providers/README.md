# Provider guides

BiBCode currently supports these coding-agent providers:

| Provider                  | Default state | Native integration        | Activity                                              |
| ------------------------- | ------------- | ------------------------- | ----------------------------------------------------- |
| [Codex](./codex.md)       | Enabled       | Codex App Server JSON-RPC | Structured chat and conditional terminal observation. |
| [Claude](./claude.md)     | Enabled       | Stream-JSON CLI and hooks | Capability-gated chat and terminal observation.       |
| [OpenCode](./opencode.md) | Enabled       | HTTP and server events    | Structured chat and conditional terminal observation. |
| [Cursor](./cursor.md)     | Disabled      | Agent Client Protocol     | Early Access; no structured activity in protocol v2.  |

Start with [Provider setup](../getting-started/provider-setup.md) for installation
and authentication commands. Provider CLIs and credentials live on the machine
or remote environment running the BiBCode server, not in the browser client.

Provider instances are configured in Settings. Each instance can select its
binary, environment, display name, and driver-specific options. The server
probes the configured executable and reports installation, authentication, and
model discovery independently; a driver being supported does not guarantee
that its local CLI is installed or ready.
