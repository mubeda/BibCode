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

Provider-terminal observation has a separate capability and safety gate. The
executable must support the required settings switches and BiBCode's additive
hook preparation. If preparation cannot be established before spawn, the
original Claude terminal command runs without structured terminal activity.

See [Activity observation](../architecture/activity-observation.md) for the
shared protocol and provider matrix.
