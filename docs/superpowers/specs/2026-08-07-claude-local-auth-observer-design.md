# Claude Local Authentication Observer Design

Date: 2026-08-07

## Context

BiBCode's Claude usage integration currently treats the Claude CLI credential
record as shared mutable state. On macOS it caches the decoded Keychain payload
for the life of the server process. When the access token is near its local
`expiresAt`, BiBCode calls Anthropic's OAuth refresh endpoint itself and writes
the rotated payload back to either the credential file or Keychain.

That behavior conflicts with the local-provider model used by **Settings →
Agents**. The installed Claude CLI is the owner of login, refresh-token
rotation, and logout. A second writer can retain credentials replaced by an
external login, overwrite a newer rotating refresh token, or make separate
processes disagree about the active session. The status bar can then continue
to report an old credential after `claude` has logged in successfully.

Refresh semantics compound the problem:

- `server.refreshProviderUsage` always uses the background throttle, so a user
  click within 30 seconds of an automatic refresh can do no work.
- the status bar single-flights manual and automatic refreshes together, so a
  click can join a request that started before the external login;
- changing a Claude provider's enabled state refreshes provider inventory but
  does not refresh the separate provider-usage snapshot.

This design changes BiBCode only. Orca remains a read-only implementation
reference and no Orca source is modified.

## Goals

- Make the installed Claude CLI the sole owner and writer of its local
  credentials.
- Observe a successful external Claude login on the next forced BiBCode
  refresh without restarting BiBCode.
- Keep automatic polling bounded while making explicit user refreshes
  deterministic.
- Refresh both Claude readiness and Claude usage after the user re-enables a
  Claude agent.
- Preserve the existing **Settings → Agents** integration and local installed
  provider accounts. Do not add or extend AI Provider Account management.
- Keep credential values out of logs, command arguments, RPC payloads, and UI
  state.

## Non-goals

- Managing, switching, importing, deleting, or persisting Claude accounts.
- Refreshing or repairing Claude OAuth credentials inside BiBCode.
- Running an interactive Claude login from BiBCode.
- Adding Orca's managed-account, WSL, PTY usage-panel, or account-preview
  systems.
- Changing Enterprise authentication policy or Claude CLI session duration.
- Modifying Orca.

## Considered Approaches

### 1. Read-only observer with explicit forced refresh — selected

BiBCode rereads the current local credential source for every usage attempt,
uses the access token only to query the usage endpoint, and never refreshes or
writes the credential payload. Automatic refreshes remain throttled; manual
refreshes and re-enable transitions are explicitly forced.

This has the smallest ownership surface and eliminates the competing-writer
failure. It also matches the product promise that local provider accounts are
owned by installed provider CLIs.

### 2. Coordinated BiBCode OAuth writer

Keep direct OAuth refresh but add Keychain locks, rereads, token-generation
checks, and compare-and-swap persistence. This could refresh usage without
starting Claude, but it would preserve two credential owners and depend on
undocumented OAuth rotation details. Cross-process locking would still not
coordinate with the Claude CLI. Rejected.

### 3. Delegate every usage refresh to a Claude PTY

Open Claude's interactive `/usage` panel and parse its output. The CLI would
own credential repair, but the integration would require terminal emulation,
prompt detection, cancellation, version compatibility, and output parsing.
That is disproportionate to the observed stale-auth bug and would create a
second provider runtime path. Deferred as a separate capability if the OAuth
usage endpoint becomes insufficient.

## Architecture

### Credential ownership and source order

`apps/server` remains the owner of provider-usage network I/O, but becomes a
read-only consumer of Claude authentication state.

For each Claude usage attempt, the server resolves the effective Claude config
directory and reads fresh credentials in this order:

1. on macOS, the config-scoped Keychain service
   `Claude Code-credentials-<first 8 hex characters of sha256(config dir)>`;
2. on macOS, the legacy `Claude Code-credentials` service;
3. `<config dir>/.credentials.json` as the legacy file fallback.

The default config directory is `$HOME/.claude`; `CLAUDE_CONFIG_DIR` replaces
it when set. The scoped-service hash uses the exact UTF-8 config-directory
string Claude receives. A non-UTF-8 directory skips the scoped service but can
still use the legacy service and file. `BIBCODE_CLAUDE_KEYCHAIN_ACCESS=disabled`
continues to disable Keychain reads and leaves the file fallback available.
Keychain reads use `/usr/bin/security` with service and account identifiers
only; secrets never appear in process arguments.

The first non-empty OAuth access token is sent to the existing Anthropic usage
endpoint. Local `expiresAt` is advisory rather than authoritative for this
read-only probe: the usage server decides whether the token is accepted. If a
token receives HTTP 401, the fetcher may continue to the next distinct local
credential source so a dead scoped item cannot shadow a newer legacy item. It
does not retry other HTTP or transport failures against alternate sources.
No rejected token is refreshed or persisted by BiBCode. The next forced refresh
rereads the external store, allowing a Claude CLI login or rotation to be
observed immediately.

The credential cache, direct OAuth refresh request, Keychain/file write paths,
and corresponding write command are removed from provider usage.

### Refresh policy

The typed `server.refreshProviderUsage` input gains an optional `force`
boolean. Missing or `false` means a background refresh and retains the current
30-second throttle. `true` bypasses only that throttle; timeouts, cancellation,
generation ownership, stale-result rejection, and last-good snapshot retention
remain unchanged.

The status bar uses two paths:

- initial and interval refreshes send `force: false` and continue to
  single-flight per environment;
- the refresh button sends `force: true`, does not join a background flight
  that may have started before the click, and remains single-flight with other
  manual clicks.

Concurrent background and forced refreshes are safe because the existing
per-provider refresh generation allows only the newest generation to commit.

### Settings → Agents re-enable flow

Provider inventory and usage remain separate sources of truth:

- `claude auth status --json` remains authoritative for the Agents card's
  authentication state;
- the OAuth usage endpoint remains authoritative only for quota windows.

When a Claude instance transitions from disabled to enabled, the existing
settings update completes first. A successful update already performs the
server's Claude readiness probe. The web client then sends a forced Claude-only
usage refresh and refreshes the environment-scoped usage query after the
server commits it. A rejected settings update triggers neither follow-up.

Disabling Claude, changing unrelated Claude fields, or toggling another
provider does not perform this forced usage refresh.

## Data Flow

### Manual status-bar refresh

1. The user clicks **Refresh provider usage**.
2. The web client sends `server.refreshProviderUsage` with Claude, Codex, and
   `force: true`.
3. The server bypasses the background debounce.
4. The Claude fetcher rereads Keychain/file state and performs a read-only
   usage request.
5. The newest provider generations commit.
6. The web client refreshes `server.getProviderUsage` after the command
   settles.

### Claude re-enable

1. The user enables a Claude instance in **Settings → Agents**.
2. `server.updateSettings` persists the instance and completes the normal
   provider readiness probe.
3. On success, the client sends a forced Claude-only usage refresh.
4. The client refreshes the usage query after that command settles.

## Failure Semantics

- Missing credentials produce an unavailable usage snapshot and guidance to
  sign in with the installed Claude CLI.
- A rejected token produces a usage error that reports the bounded HTTP status
  without claiming that provider inventory is unauthenticated.
- Keychain denial or timeout falls through to the legacy file source. If no
  source can be read, usage is unavailable; provider inventory remains
  independently reported.
- Network, proxy, malformed-response, and endpoint errors never mutate local
  credentials.
- A failed forced refresh retains the existing last-good usage windows through
  the current snapshot policy while exposing the current error.
- Cancellation cannot leave `isFetching` stuck and cannot let an older
  generation overwrite a newer forced result.

## Security and Trust Boundaries

- Claude credentials stay on the machine or remote environment running the
  BiBCode server.
- The browser never reads, receives, or writes Claude credentials.
- Normal refresh control crosses the existing typed WebSocket RPC boundary.
- `/usr/bin/security` receives no secret argument; credential JSON is read only
  from stdout and is never logged.
- No direct OAuth refresh token is sent by BiBCode after this change.
- No new persistence format or provider-account store is introduced.

## Testing

### Server

- A forced refresh performs a second fetch inside the 30-second background
  throttle window; an unforced refresh remains throttled.
- RPC decoding defaults missing `force` to false and routes `force: true` to
  the forced service path.
- An access token with an elapsed local `expiresAt` is tried against the usage
  endpoint and its credential file remains byte-for-byte unchanged.
- Replacing local credentials between attempts changes the token observed by
  the second request.
- macOS Keychain service derivation covers scoped and legacy ordering without
  putting secrets in command arguments.
- Credential absence and HTTP rejection preserve honest unavailable/error
  states.

### Contracts and web

- The refresh input accepts optional `force` and rejects non-boolean values.
- Automatic status-bar refresh sends `force: false`; the button sends
  `force: true` and does not coalesce into an earlier automatic flight.
- Enabling a Claude instance waits for a successful settings update, performs
  one forced Claude usage refresh, and then refreshes the query.
- Failed settings updates, disable transitions, unrelated edits, and other
  providers do not trigger the Claude usage follow-up.

### Repository verification

- Focused Rust, contract, and React tests.
- Broader affected package tests.
- `vp check` and `vp run typecheck`.
- `cargo fmt --all --check`, affected Rust tests, and Clippy with warnings
  denied.
- Final diff and status review confirming no Orca file changed.

## Success Criteria

1. Logging in through the installed `claude` command and then clicking the
   BiBCode usage refresh causes the new local credential to be read without a
   BiBCode restart.
2. BiBCode provider usage contains no Claude credential write or OAuth refresh
   path.
3. A manual refresh is never discarded solely because an automatic refresh
   started during the preceding 30 seconds.
4. Re-enabling a Claude agent updates readiness through the existing provider
   probe and refreshes its usage immediately after a successful settings
   update.
5. Authentication and usage failures remain separate: a usage endpoint error
   does not rewrite the Agents card's authentication result.
6. No Orca source or AI Provider Account management code changes.
