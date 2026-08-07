# OpenCode

Install OpenCode on the machine running the BiBCode server, then authenticate its
providers:

```bash
opencode auth login
```

The default BiBCode instance can remain:

```text
Display name: OpenCode
Binary path: opencode
Server URL: empty
Server password: empty
```

## Updates and version advisories

BiBCode selects an update source from the resolved `opencode` executable and
its canonical target, not from a separate package-manager inventory. Native
OpenCode installations use the resolved `opencode upgrade` action; recognized
Homebrew installations use `brew upgrade anomalyco/tap/opencode`; recognized
npm, pnpm, Bun, and Vite+ paths use their matching global-install command.
Each recognized row gets its latest-version advisory from npm's `opencode-ai`
latest document, while the update action remains installation-specific.

On Windows, a recognized npm-backed `opencode.cmd` path selects `npm install
-g opencode-ai@latest`; the server resolves the platform's npm command shim
from the provider environment. This is path-based source selection, so Windows
runtime behavior still depends on the actual host's npm shim and `PATH`.

An arbitrary custom executable or wrapper is manual-only. BiBCode does not
publish a latest-version advisory or execute an update action for an unproven
path. Following a zero-exit action, it reprobes the same instance and reports
success only when a fresh advisory is current or the installed version provably
advanced.

## Managed local server

When **Server URL** is empty, BiBCode starts a private OpenCode server for the
session:

```text
opencode serve --hostname=127.0.0.1 --port=<available-port>
```

BiBCode generates a temporary password, waits for the loopback endpoint to
become ready, and stops the child process with the provider session. Inventory
uses the same managed-server approach to discover authentication state, models,
agents, and commands.

## Existing OpenCode server

Set **Server URL** to connect to an OpenCode server you already operate. Set
**Server password** when that endpoint requires one.

The OpenCode server password field is currently stored in plain text in BiBCode's
settings file. Prefer the managed local server, or otherwise protect the server's
state directory and use a narrowly scoped credential. Provider-instance
Environment variables marked Sensitive use BiBCode's separate secret storage,
but the dedicated Server password field does not.

## Provider terminal and activity

The provider terminal launches `opencode` in the active worktree. BiBCode adds a
small terminal-only theme override so the TUI follows the embedded terminal's
colors; it does not replace your normal OpenCode configuration.

OpenCode chats and provider terminals can publish structured activity when the
installed provider path supports observation. Failure to prepare terminal
observation leaves the normal terminal command available without structured
activity.
