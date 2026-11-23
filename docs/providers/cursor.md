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
authentication status and queries ACP for available models. A Cursor that
reports itself signed in can still require a browser sign-in when it gets a
prompt: it opens a Cursor sign-in page and sends nothing until you finish it.

The model picker lists each Cursor model once, by its base name, with its
reasoning, context, fast and thinking options. BiBCode sends the session only a
model value the session advertises. Cursor CLIs since 2026.11 advertise one
value per model with its options folded in, such as
`gpt-5.4-nano[reasoning=medium]`, and reject a plain model name; BiBCode sends
that advertised value. With these CLIs the picker offers each model only the
option values an advertised value carries, and only options it can offer
together: when the CLI advertises some combinations of two options but not
others, such as High reasoning only with Fast on, the picker shows one of them
and Cursor's advertised value decides the other. A model the CLI advertises as a
plain value, such as Auto, keeps its place without options, and a custom model
appears only when the CLI advertises it. Provider inventory opens one empty
Cursor session per CLI version, model list and instance environment to read the
advertised values (Cursor does not list empty sessions); refreshes at the same
time share that one read, and a read that fails is not tried again for a few
minutes, while the model list is published without it. An option that no advertised value of the model holds, such as one
saved from an older catalog, is refused before the turn is sent with a message
naming it and saying to choose another option, as is a model the session does
not offer.
Older CLIs that advertise plain values and separate options keep working the
same way. Clearing a model's options goes back to the values Cursor offered when
the session started. When Cursor no longer offers those values, it keeps the
ones it uses now, BiBCode sends no change, and the chat shows "Cursor no longer
offers this model's previous default options, so it keeps its current ones." Auto, and a thread with no model selected, sends the session's
advertised `default[...]` value, so it never runs the model the CLI last
remembered; a session that advertises no default value leaves the choice to
Cursor.

A Cursor turn that receives no update at all for five minutes, while it waits
on neither the user nor a tool Cursor reports running, shows the notice
"Cursor has sent nothing for 5 minutes. It may be waiting for you to sign in to
Cursor in your browser, or one of its MCP servers may not be responding;
otherwise stop the turn if it seems stuck." The
turn keeps running; BiBCode never ends it by itself, and the notice clears when
Cursor sends its next update. A tool Cursor reports only as pending, or as
finished in any way, does not pause that clock.

After **Stop**, BiBCode drops everything Cursor still sends for that turn: no
text, plan or to-do update appears, no approval or question opens, and a late
permission request or question is answered as cancelled, never approved. If
Cursor does not end the stopped turn within ten seconds, the turn ends as
cancelled and BiBCode stops the Cursor process, as a requested stop rather than
a crash, so nothing the old prompt still produces can reach the next message;
the next message starts Cursor again and resumes the session. BiBCode also stops
the process when Cursor does not take a prompt within 30 seconds; a prompt it
did not read at all is sent again, one it may have partly read is not. A prompt
you stopped is never sent again, even if Cursor never read it. A **Stop** that
names a turn stops only that turn: a late Stop for a turn that already ended
leaves the next turn alone, so that turn is not cancelled and a prompt Cursor
has not read yet can still be sent.

Cursor waits silently for an MCP server that never connects. If Cursor has not
finished starting the session within 60 seconds, the chat shows "Cursor is
taking longer than usual to start. One of its MCP servers may not be
responding; run `cursor-agent mcp list` in a terminal to see which one." and
BiBCode keeps waiting; see [Starting a provider](README.md#starting-a-provider).
Model discovery has its own, shorter limits, so the model picker still lists
models when Cursor does not answer.

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
