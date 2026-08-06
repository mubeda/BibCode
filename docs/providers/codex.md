# Codex

Install the Codex CLI, make sure `codex` is on the BiBCode server's `PATH`, and
sign in:

```bash
codex login
```

For one account, the default provider instance needs no custom home:

```text
Display name: Codex
Binary path: codex
CODEX_HOME path: empty
Shadow home path: empty
```

An empty `CODEX_HOME path` lets Codex use its normal default. BiBCode resolves
that default as `~/.codex` when grouping Codex state internally.

## Shared state with separate authentication

Codex can use a shared home for sessions and configuration while keeping a
second account's `auth.json` in a shadow home.

First, authenticate the normal account:

```bash
codex login
```

Then authenticate the second account in a separate home:

```bash
mkdir -p ~/.codex-personal
CODEX_HOME=~/.codex-personal codex login
```

Configure two provider instances:

```text
Display name: Codex Work
Binary path: codex
CODEX_HOME path: ~/.codex
Shadow home path: empty

Display name: Codex Personal
Binary path: codex
CODEX_HOME path: ~/.codex
Shadow home path: ~/.codex-personal
```

Before starting the second instance, BiBCode prepares its shadow home. The
shadow keeps its own `auth.json` and links shared, non-private Codex state back
to the configured `CODEX_HOME`.

Do not copy or delete a whole Codex home as a troubleshooting step. Back up both
directories before changing them, and verify that the shadow directory contains
its own regular `auth.json` file.

### Current account-status limitation

The provider status probe does not currently apply the configured Codex home or
shadow home. The account email shown in Settings may therefore describe the
server's default Codex login rather than the selected shadow account. Use clear
display names, and verify the account from the Codex session when identity
matters.

BiBCode also does not currently publish the shared-home continuation group in
provider status. Existing-thread model pickers are locked to the Codex driver,
but must not be treated as proof that every displayed Codex instance can safely
resume the same provider session. Prefer the instance that created the thread.

## Custom endpoints and secrets

Add account-specific variables in the provider instance's **Environment
variables** section. Mark API keys and tokens as **Sensitive**. BiBCode stores
sensitive values as server secrets and does not send the value back to the app
after saving.

## Activity observation

Structured Codex chats run through `codex app-server`. BiBCode uses App Server
events for live activity and feature-detects optional reconciliation methods such
as descendant-thread, history, and background-terminal discovery. Unsupported
methods degrade the affected activity view instead of inventing data.

Provider-terminal activity is also capability-gated. BiBCode probes the
configured executable before adding its private remote-observation arguments. If
the required switches are unavailable or preparation fails safely, the original
Codex terminal command runs without structured terminal activity.

See [Activity observation](../architecture/activity-observation.md) for the
shared protocol and provider matrix.
