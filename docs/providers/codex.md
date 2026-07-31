# Codex

This guide is for people who want to use more than one Codex account in BiBCode.

Common reasons:

- use a work account for work projects
- use a personal account for personal projects
- switch to another account when one account hits limits
- keep one shared Codex history instead of maintaining two separate Codex setups

## I Only Use One Codex Account

Use the default provider.

In Settings, your Codex provider can stay like this:

```text
Display name: Codex
CODEX_HOME path: ~/.codex
Shadow home path: empty
```

Log in with Codex normally:

```bash
codex login
```

## I Want Work And Personal Codex Accounts

Use one real Codex home and one shadow home.

Recommended setup:

```text
~/.codex      shared Codex home
~/.codex_p    second account auth
```

The idea is:

- both accounts can see the same BiBCode/Codex sessions
- each account keeps its own login
- existing threads can continue with either account

### Set Up The First Account

Log in normally:

```bash
codex login
```

This is the account used by `~/.codex`.

In BiBCode Settings, name it something obvious:

```text
Display name: Codex Work
CODEX_HOME path: ~/.codex
Shadow home path: empty
```

### Set Up The Second Account

Log in with a separate Codex home:

```bash
mkdir -p ~/.codex_p
CODEX_HOME=~/.codex_p codex login
```

In BiBCode Settings, add another Codex provider:

```text
Display name: Codex Personal
CODEX_HOME path: ~/.codex
Shadow home path: ~/.codex_p
```

The important part is that both providers use the same `CODEX_HOME path`, but only the second one
has a `Shadow home path`.

## Which Account Am I Using?

Open Settings and look at the provider row.

BiBCode shows the authenticated email for providers that report one. Emails are blurred by default;
click the blurred email to reveal it.

Use display names and accent colors to make accounts easy to tell apart in the model picker.

## Activity Observation

BiBCode feature-detects Codex activity; it does not promise support from an
indefinite CLI version range.

For structured chat, Codex App Server events provide live actors and attributed
entries. Reconciliation probes provider methods by using them:
`thread/list` discovers descendants, `thread/read` recovers their history, and
`thread/backgroundTerminals/list` discovers background work. Method-not-found
or incompatible responses downgrade history recovery or the Background Tasks
section instead of fabricating data.

For a Codex provider terminal, BiBCode runs bounded `--version`, `--help`, and
`app-server --help` probes against the configured executable. Observation
requires help output that advertises:

- `app-server --listen` with a `unix://` endpoint; and
- the root `--remote` switch with a `unix://` endpoint.

BiBCode starts the private App Server listener and appends `--remote` itself.
Existing `--remote` or `--remote-auth-token-env` launch arguments are not
rewritten. A rejected probe, failed preparation, or preparation timeout passes
through the original command. Once a prepared Codex command is selected, a
prepared-command spawn failure or collision with a reserved observer environment
key is a hard terminal error. If the bounded `on_spawned` callback times out or
panics, BiBCode cancels the observer and fences further activity publication but
continues registering the prepared Codex command as the running terminal. It
does not respawn the original command.

Root discovery and `thread/resume` correlation run asynchronously after
`on_spawned`. Failure there does not respawn the original command: the prepared
remote terminal continues and no activity scope is published. After a scope is
published, optional reconciliation failure preserves known activity and
capabilities. A later observer transport failure does not directly mark its
unresolved records interrupted.

See [Activity observation](../architecture/activity-observation.md) for the
shared protocol and provider matrix. Codex mapping, downgrade, and handshake
behavior are covered by
[`apps/server/tests/provider_codex.rs`](../../apps/server/tests/provider_codex.rs),
[`apps/server/tests/provider_terminal_supervisor.rs`](../../apps/server/tests/provider_terminal_supervisor.rs),
and the
[`codex-remote-handshake.json`](../../apps/server/tests/fixtures/provider-terminal/codex-remote-handshake.json)
fixture.

## I Need A Different API Key Or Endpoint

Use the provider's Environment variables section in Settings.

This is useful when a Codex-compatible setup needs account-specific variables. Add the variables to
the provider instance that should receive them, and mark API keys or tokens as sensitive. Sensitive
values are stored as server secrets and are not sent back to the app after saving.

## Can I Switch Accounts In An Existing Thread?

Yes, when both Codex providers share the same `CODEX_HOME path`.

For example:

```text
Codex Work      CODEX_HOME path: ~/.codex
Codex Personal  CODEX_HOME path: ~/.codex, Shadow home path: ~/.codex_p
```

Those two providers are considered compatible for continuation, so the locked model picker can show
both.

If you add a third Codex provider with a completely different `CODEX_HOME path`, BiBCode treats it
as a different workspace. It will not be offered for existing threads created under `~/.codex`.

## If Both Accounts Look The Same

If two Codex providers show the same account or the same unexpected model list:

1. Check the email in Settings.
2. Refresh provider status.
3. Confirm the second provider has `Shadow home path` set.
4. Confirm the shadow directory has its own `auth.json`.
5. If you copied `~/.codex` into the shadow directory, remove everything except `auth.json`.

Example cleanup:

```bash
find ~/.codex_p -mindepth 1 ! -name auth.json -exec rm -rf {} +
```

## When To Use A Separate CODEX_HOME

Use a totally separate `CODEX_HOME path` only when you want a separate Codex workspace.

That means separate sessions and less account switching inside old threads. Most dual-account users
should use the shared-home plus shadow-home setup instead.
