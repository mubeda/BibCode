# Provider setup

BiBCode supports four coding-agent providers:

| Provider                             | Command        | Sign in               |
| ------------------------------------ | -------------- | --------------------- |
| [Codex](../providers/codex.md)       | `codex`        | `codex login`         |
| [Claude](../providers/claude.md)     | `claude`       | `claude auth login`   |
| [Cursor](../providers/cursor.md)     | `cursor-agent` | `cursor-agent login`  |
| [OpenCode](../providers/opencode.md) | `opencode`     | `opencode auth login` |

Install and authenticate at least one provider before starting a chat. The
provider executable and its credentials must be available on the machine that
runs the BiBCode server:

- For the desktop app, that is normally the desktop machine.
- For a headless, SSH, or WSL environment, install and authenticate the provider
  inside that environment.
- Browser clients do not run provider CLIs locally.

Provider installations, credentials, configuration, and processes belong to
their environment. Adding the same Git repository on a second environment does
not reuse the first environment's provider session or project data. See
[Environments](../user/environments.md) for the ownership model and
[Server-only installation](./server-installation.md) when preparing a remote
host.

BiBCode resolves provider executables from the server process's `PATH`. You can
also set an explicit **Binary path** on a provider instance in Settings.

Provider instances can have their own display name, accent color, configuration,
and environment variables. Mark API keys and tokens as **Sensitive** so BiBCode
stores them separately as server secrets and returns only a redacted value to the
app after saving.

See the [provider guides](../providers/README.md) for provider-specific behavior
and limitations.
