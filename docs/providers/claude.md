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

## Updates and version advisories

BiBCode resolves the configured executable before selecting a release source
and action, so a package-manager inventory cannot update a different Claude
installation. The recognized installation rows are:

| Installation                                    | Latest source                       | Action in BiBCode                                      |
| ----------------------------------------------- | ----------------------------------- | ------------------------------------------------------ |
| Native `~/.local/bin/claude`                    | Claude `stable` or `latest` channel | Resolved `claude update`                               |
| Homebrew `claude-code` cask                     | Claude `stable`                     | `brew upgrade --cask claude-code`                      |
| Homebrew `claude-code@latest` cask              | Claude `latest`                     | `brew upgrade --cask claude-code@latest`               |
| WinGet `Anthropic.ClaudeCode`                   | Claude `latest`                     | `winget upgrade Anthropic.ClaudeCode`                  |
| Marked apt, dnf, or apk repository installation | Repository's stable/latest channel  | Display-only system command; BiBCode never executes it |
| Recognized npm/pnpm/Bun/Vite+ path              | npm                                 | Matching package-manager command                       |

For Linux repository installations, the display-only guidance is respectively
`sudo apt update && sudo apt upgrade claude-code`, `sudo dnf upgrade
claude-code`, or `apk update && apk upgrade claude-code`. It is provided for a
user to run with the required privileges, not as a server update action.

Channel selection reads bounded user and managed settings. Managed settings take
precedence, and only managed `autoUpdatesChannel` values of `stable` or `latest`
are valid for BiBCode's release source; another managed value leaves latest
metadata unavailable instead of guessing. `DISABLE_UPDATES=1`, whether in the
effective provider environment or settings, disables executable update actions
but does not suppress recognized advisory metadata or display-only guidance.
`DISABLE_AUTOUPDATER` alone does not control this BiBCode action.

Custom executable paths and wrappers are manual-only. BiBCode does not infer an
updater for them. A zero command exit is also advisory only: the post-update
probe must show a current advisory or a provable installed-version advance
before the update is reported as successful.

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
