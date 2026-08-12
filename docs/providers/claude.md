# Claude

Install Claude Code, make sure `claude` is on the BiBCode server's `PATH`, and
sign in:

```bash
claude auth login
```

The default provider instance can remain simple:

```text
Display name: Claude
Binary path: claude
```

BiBCode probes `claude auth status --json` and shows the reported account when
available. Account text is blurred by default in Settings.

## Local account and usage status

The Claude CLI owns the local account and its credential lifecycle. BiBCode's
server is a read-only observer: it does not exchange refresh tokens, rotate
access tokens, rewrite `.credentials.json`, or update macOS Keychain items.
The **Agents** authentication state remains the result of `claude auth status
--json`; the status-bar usage request is a separate quota observation and does
not replace that readiness probe.

Every Claude usage fetch reads the current credential sources again. On macOS
the order is:

1. `Claude Code-credentials-<suffix>`, where `<suffix>` is the first eight
   hexadecimal characters of SHA-256 over the exact UTF-8 Claude config
   directory string;
2. the legacy `Claude Code-credentials` Keychain service;
3. `<config-directory>/.credentials.json`.

The config directory is `CLAUDE_CONFIG_DIR` when set and otherwise
`$HOME/.claude`. An explicit `CLAUDE_CONFIG_DIR` still participates in scoped
Keychain lookup. A non-UTF-8 directory skips only the scoped service, and
`BIBCODE_CLAUDE_KEYCHAIN_ACCESS=disabled` disables all Keychain reads while
preserving file lookup. Other platforms use the credential file.

BiBCode sends the current non-empty access token to Anthropic's usage endpoint
even when the locally recorded `expiresAt` is in the past; the server response
is authoritative. An HTTP 401 may try the next distinct credential source.
Other HTTP, transport, and JSON failures are returned without switching
credentials.

Status-bar polling uses the normal throttled refresh. Clicking its refresh
button is an explicit forced fetch and may overlap a background fetch. Enabling
a previously disabled Claude provider in **Settings → Agents** waits for the
settings update and readiness probe to succeed, then performs the same forced
Claude-only usage refresh. After signing in with the Claude CLI, either action
therefore observes the newly written local credentials without restarting
BiBCode.

## Context-window usage

Claude stream events provide the live context-usage fallback. After a successful
turn result, BiBCode sends the official response-correlated
`get_context_usage` control query and bounds the whole write-and-response
operation to two seconds. A successful response supplies `totalTokens` as the
active context usage, `maxTokens` as its maximum, and
`isAutoCompactEnabled` as the automatic-compaction indicator. It is applied
only while the completed turn is still current; late responses for an earlier
turn are rejected.

Unsupported, malformed, timed-out, cancelled, EOF, or write-failed control
queries are nonfatal. They leave the last good stream/result-derived context
usage in place and release completion without waiting longer. Pending control
response waiters are removed on timeout and shutdown. Accumulated totals in
Claude result messages are lifetime processed metadata only; they never replace
active context-window usage.

## Updates and version advisories

BiBCode resolves the configured executable before selecting a release source
and action, so a package-manager inventory cannot update a different Claude
installation. The recognized installation rows are:

| Installation                                    | Latest source                                             | Action in BiBCode                                      |
| ----------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------ |
| Native `~/.local/bin/claude`                    | Claude `stable` or `latest` channel; defaults to `latest` | Resolved `claude update`                               |
| Homebrew `claude-code` cask                     | Claude `stable`                                           | `brew upgrade --cask claude-code`                      |
| Homebrew `claude-code@latest` cask              | Claude `latest`                                           | `brew upgrade --cask claude-code@latest`               |
| WinGet `Anthropic.ClaudeCode`                   | Claude `latest`                                           | `winget upgrade Anthropic.ClaudeCode`                  |
| Marked apt, dnf, or apk repository installation | Repository's stable/latest channel                        | Display-only system command; BiBCode never executes it |
| Recognized npm/pnpm/Bun/Vite+ path              | npm                                                       | Matching package-manager command                       |

For Linux repository installations, the display-only guidance is respectively
`sudo apt update && sudo apt upgrade claude-code`, `sudo dnf upgrade
claude-code`, or `apk update && apk upgrade claude-code`. It is provided for a
user to run with the required privileges, not as a server update action.

Channel selection defaults native Claude to `latest` when user settings are
absent or malformed. Managed settings take precedence, and only managed
`autoUpdatesChannel` strings `stable` and `latest` are valid; every other
present value, including null or another JSON type, leaves latest metadata
unavailable instead of guessing.

BiBCode reads only regular local settings and repository evidence. File size,
managed-fragment count and aggregate size, and I/O time are bounded; special
files, metadata races, timeouts, overflow, and read errors fail closed.
`DISABLE_UPDATES=1`, whether in the effective provider environment or settings,
disables executable update actions but does not suppress recognized advisory
metadata or display-only guidance. `DISABLE_AUTOUPDATER` alone does not control
this BiBCode action.

Custom executable paths and wrappers are manual-only. BiBCode does not infer an
updater for them. A zero command exit is also advisory only: the post-update
probe must show a current advisory or a provable installed-version advance
from a fresh exact-target pre-command probe before the update is reported as
successful.

When the command exits successfully but the exact executable remains outdated,
BiBCode reports the resolved executable path together with the detected and
expected versions. Provider settings retain the captured updater output and a
**Recheck** action so an externally repaired installation can be verified
without rerunning the update. The server log records the provider, instance,
executable, before/after/expected versions, exit code, and verification status
as structured `provider.maintenance.update.verify` fields.

## Supported instance customization

The following provider-instance settings are applied by the current runtime:

- **Binary path** selects the Claude executable.
- **Environment variables** are passed to inventory probes and chat sessions.
- Variables marked **Sensitive** are stored separately as server secrets. The
  saved value is redacted when settings are returned to the app.

This supports Claude-compatible gateways and routing tools without a special
BiBCode driver. Copy the environment variables required by the gateway into the
Claude provider instance, mark credentials as Sensitive, and use the gateway's
current documentation for endpoint and model values.

Avoid placing provider-specific credentials in global shell startup files when
only one Claude instance needs them.

## Current settings limitations

The settings schema currently displays **Claude HOME path** and **Launch
arguments**, but the native runtime does not apply either field when probing or
starting Claude. Do not rely on those fields for account isolation or extra CLI
arguments.

If an advanced setup needs a different process home today, set `HOME` explicitly
in that provider instance's Environment variables (`USERPROFILE` on Windows) and
authenticate Claude under that same home. This is process-environment behavior;
BiBCode does not validate or migrate Claude's files.

Existing-thread model pickers currently lock to the Claude driver, not to a
configured Claude home. Prefer the provider instance that created the thread;
the UI does not guarantee that switching to another Claude instance can resume
the same provider session.

## Activity observation

BiBCode detects Claude activity features from the configured executable instead
of promising support for an indefinite version range.

For structured chat, it probes `--version` and `--help`. Hook activity is enabled
only when help advertises both exact switches:

- `--include-hook-events`
- `--forward-subagent-text`

If either switch is unavailable or the bounded probe fails, Claude still runs in
its normal stream-JSON mode without structured hook activity.

Structured chat control correlation is stricter than display observation.
BiBCode exposes a private task target only after one session and Activity
generation proves the complete identity chain: a root Agent/legacy Task tool
invocation, its authenticated asynchronous PostToolUse result carrying the
same `tool_use_id` and `agentId`, a local-agent `task_started` record carrying
that `tool_use_id` and `task_id`, and the matching `SubagentStart` `agent_id`.
Arrival order is irrelevant. Names, roles, descriptions, prompts, timestamps,
output paths, and event proximity are never correlation keys; incomplete,
conflicting, stale, malformed, or saturated chains remain observable but
uncontrollable. Only bounded identities and terminal status are retained, and
provider-native IDs do not cross persistence, contracts, or logs.

A `task_notification` with status `stopped` is authoritative cancellation for
an exactly mapped actor and retires its private target. A later
`SubagentStop` cannot rewrite cancelled, interrupted, or failed lifecycle to
completed. The provider-specific `stop_task` request and capability downgrade
are described separately when dispatch support is enabled.

Provider-terminal observation has a separate capability and safety gate. The
executable must support the required settings switches and BiBCode's additive
hook preparation. If preparation cannot be established before spawn, the
original Claude terminal command runs without structured terminal activity.

See [Activity observation](../architecture/activity-observation.md) for the
shared protocol and provider matrix.
