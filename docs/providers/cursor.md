# Cursor

Cursor support is currently **Early Access** and disabled by default.

Install the Cursor CLI on the machine running the BiBCode server, then sign in:

```bash
cursor-agent login
```

Add or enable a Cursor provider instance in Settings:

```text
Display name: Cursor
Binary path: cursor-agent
API endpoint: empty
```

Leave **API endpoint** empty for Cursor's normal endpoint. Set it only when your
Cursor installation requires an explicit endpoint override.

## Runtime behavior

BiBCode starts `cursor-agent acp` and communicates through the Agent Client
Protocol (ACP). It initializes the connection, authenticates with the
`cursor_login` method, and creates or loads a Cursor session for the active
workspace. Provider inventory uses `cursor-agent about` for installation and
authentication status and queries ACP for available models.

Cursor workspace slash commands, skills, and agents are discovered from the
server-side workspace environment. Because this integration is Early Access,
capabilities can vary with the installed Cursor CLI.

## Updates and version advisories

BiBCode recognizes an update source only when the resolved executable and its
canonical target match the official Cursor release layout. It fetches the
official installer document and parses matching release identifiers from its
download and installation paths; it never executes downloaded installer text.
For a recognized official installation, BiBCode offers the resolved
`cursor-agent update` command and compares release dates for the advisory.

Custom paths and wrapper scripts remain manual-only. BiBCode intentionally
withholds both latest-version metadata and an update action for those paths
instead of running an update command against an unverified installation. A
zero exit is not enough to report success: BiBCode reprobes the provider and
requires either a current advisory or a provable release-date advance.

## Provider terminal

The provider terminal launches `cursor-agent --yolo` using the configured binary
and provider environment. Cursor provider terminals do not currently publish
structured BiBCode terminal activity. Review the command's permission behavior
before using it on an unfamiliar repository.
