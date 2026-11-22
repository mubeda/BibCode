# Cursor

Cursor is a supported provider and is enabled by default. Its installation and
authentication status remain truthful: if `cursor-agent` is unavailable or not
signed in, Settings keeps the Cursor card visible and reports that state.

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

The model picker lists each Cursor model once, by its base name, with its
reasoning, context, fast and thinking options. BiBCode sends the session only a
model value the session advertises. Cursor CLIs since 2026.11 advertise one
value per model with its options folded in, such as
`gpt-5.4-nano[reasoning=medium]`, and reject a plain model name; BiBCode sends
that advertised value. An option that no advertised value of the model holds,
which with these CLIs is any non-default option, is refused before the turn is
sent with a message naming it, as is a model the session does not offer.
Older CLIs that advertise plain values and separate options keep working the
same way. Auto, and a thread with no model selected, sends the session's
advertised `default[...]` value, so it never runs the model the CLI last
remembered; a session that advertises no default value leaves the choice to
Cursor.

A Cursor turn that receives no update at all for five minutes, while it waits
on neither the user nor a running tool, is cancelled on the CLI as Stop does and
ends as failed with a message saying that Cursor stopped responding and to send
the message again or check the Cursor CLI. If the CLI does not answer that
cancel within ten seconds either, BiBCode stops the Cursor process, as a
requested stop rather than a crash, so nothing the old prompt still produces can
reach the next message; the next message starts Cursor again and resumes the
session. A turn that keeps streaming text,
thoughts or tool progress is never cut off, and the session takes the next
message as usual.

Cursor slash commands, skills, and agents are discovered from the server-side
workspace environment. Skills include `.cursor/skills`, `.agents/skills`,
`.claude/skills`, and `.codex/skills` in both the project and effective user home,
including nested and symlinked skill folders. For a directory below a Git root,
applicable ancestor skills are included; unrelated sibling projects are excluded.
Project definitions take precedence over user definitions with the same name.
Use `/` to open the skill menu. Capabilities can vary with the installed Cursor CLI.

The [CLI ACP documentation](https://cursor.com/docs/cli/acp) defines the
`cursor/ask_question`, `cursor/create_plan`, `cursor/update_todos`,
`cursor/task`, and `cursor/generate_image` extensions. BiBCode handles the
first three. `cursor/task` (sent when a subagent task completes) and
`cursor/generate_image` are not handled yet, so Cursor subagents and generated
images do not appear in the chat or in Activity, and Cursor claims no Activity
capability.

## Updates and version advisories

BiBCode recognizes an update source only when the resolved executable and its
canonical target match the official Cursor release layout. It fetches the
official installer document and parses matching release identifiers from its
download and installation paths; it never executes downloaded installer text.
For a recognized official installation, BiBCode offers the resolved
`cursor-agent update` command and compares release dates for the advisory.
Release identifiers are orderable only when they contain an exact, real
Gregorian `YYYY.MM.DD-build` date; malformed widths and impossible calendar
dates remain unknown.

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
