# Antigravity

Antigravity is enabled by default in **Settings → Providers** (explicitly saving it
disabled keeps it off). When `agy` is installed and enabled, BiBCode shows
Antigravity in the chat and terminal menus.

BiBCode offers two ways to use it:

- **Antigravity Terminal** launches the `agy` CLI in a provider terminal.
- **Antigravity chat** talks to `agy acp`, which speaks the Agent Client
  Protocol (ACP) over stdio.

Install the Antigravity CLI on the machine running the BiBCode server, then
check it:

```bash
agy --version
```

Chat needs CLI version 1.5.4 or later. The terminal works with older versions.

## Sign in

Sign in inside the CLI itself: run `agy` in a terminal, for example in an
Antigravity Terminal. On a server without a browser, run `agy acp --login`
instead. BiBCode never handles your credentials. If you are not signed in,
Settings and the chat report that state and tell you to sign in first.

If Google has disabled Antigravity for the signed-in account, the CLI answers
with Google's notice that the service was disabled for a violation of its Terms
of Service. BiBCode then fails the message once, without sending it again, with
"Google has disabled Antigravity for this account. Appeal through Google to
restore access." followed by Google's own notice.

## Settings

Antigravity is enabled by default in **Settings → Providers**; toggle it off
there if you do not want to use it, and if `agy` is not on the server's `PATH`,
set **Binary path**. The default is `agy`.

The IDE has shipped a launcher that is also named `agy`. If an old launcher comes
first on `PATH`, BiBCode runs the wrong program, and the version probe cannot
tell them apart. Check which one is found with `command -v agy` (or `where agy`
on Windows) and then `agy --version`. If it is the wrong one, set an absolute
**Binary path**.

## Models and thinking levels

BiBCode has no model list of its own for Antigravity. The models and thinking
levels you can pick come from what the CLI advertises. One stored default model
serves both the chat and the terminal.

## Chat

BiBCode starts `agy acp` in the thread's checkout and streams replies, tool
activity, and approval requests like the other chat providers.

- **Approval required:** BiBCode sets the CLI's `default` mode and refuses to
  start the session if the CLI does not confirm it.
- **Auto-accept edits:** BiBCode sets the CLI's `accept-edits` mode. The CLI
  edits files without asking and still asks before it runs a command.
- **Full access:** BiBCode sets the CLI's `auto` mode. The CLI then runs tools
  without asking.

If the CLI has not finished starting the session within 60 seconds, the chat
shows "Antigravity is taking longer than usual to start. One of its MCP servers
may not be responding; run `agy mcp list` in a terminal to see which one." and
BiBCode keeps waiting; see [Starting a provider](README.md#starting-a-provider).

BiBCode never answers a permission request with an approval for you, in any mode.
Normally, a request the CLI sends is always shown to you; in a code review panel
running in auto mode (`full-access` and `default`), BiBCode cancels stray
permission requests at once without opening a card (switching the panel to
Supervised or Plan restores normal cards). When you change the mode while the
agent is working, the change applies once the CLI confirms it; use **Stop** to
end the turn at once. If the CLI does not confirm a mode, the next message is
refused until it does.

## Terminal

The Antigravity Terminal starts the CLI with `--dangerously-skip-permissions`,
like the other provider terminals start their CLIs in their bypass mode. The CLI
then runs tools in that terminal without asking. The chat never uses that flag.

The first run of the CLI in a workspace asks a few questions in the terminal.
Answer them there; BiBCode does not answer them for you. It is simplest to open
an Antigravity Terminal once before the first chat.

## Usage in the status bar

**Show Antigravity usage** is on by default in **Settings → Status bar** to show
the five-hour and weekly limits the CLI reports, for each model group, with
their reset times (unset buckets omit a placeholder epoch reset time). BiBCode
reads them with `agy -p "/usage"`, which sends no prompt, at most every five
minutes; the refresh button reads at once. It needs CLI version 1.1.11 or
later and an account sign-in: with an API key there is no account quota to show.
BiBCode reads only the built-in Antigravity instance.

## Skills and slash commands

Typing `/` in an Antigravity chat opens native slash commands and skills.
BiBCode queries `agy acp` (without sending a prompt) and merges
`available_commands_update` with bounded local skill discovery across
`.agents/skills`, `.agent/skills`, `_agents/skills`, and `_agent/skills` up to
the containing Git root plus `~/.gemini/config/skills`. Matching skills appear
under **Skills** and extra ACP commands appear under **Commands**; when the CLI
is signed out, older, or times out, BiBCode falls back to locally discovered
skills and shows a notice in the menu.

## How often BiBCode contacts the CLI

Reading the model list opens and closes one session in your account. BiBCode
does that when you change Antigravity's settings, when you refresh providers by
hand, and otherwise at most every five minutes.

## Known limits

- A session that cannot be resumed starts fresh.
- BiBCode trusts the configured `agy` binary. It checks the version before it
  reads usage, but it cannot tell if the file is replaced between that check and
  the next run.
- A second Antigravity instance cannot be added from Settings yet; the add
  button is hidden for every provider.
- A very large single file write can exceed the transport's line limit and end
  the session.

## Account terms

Google's position on using the CLI from another application is not settled, and
Google was not asked about it for BiBCode. The
[Antigravity FAQ](https://antigravity.google/docs/faq) says that tools that wrap
`agy` are not supported on consumer plans. A reply written on Google's behalf in
its forum says the unmodified official ACP server is supported for interactive
development by one person, which is how BiBCode uses it: your own unmodified CLI
with your own sign-in. These two statements have not been reconciled, and whether a desktop app such as
BiBCode counts is not established. An API key or an enterprise plan is the route
Google supports officially. Read the FAQ and the
[ACP page](https://antigravity.google/docs/cli/acp), check which plan covers your
use, and decide for yourself before relying on it. Settings → Providers repeats
the FAQ's statement on the Antigravity card while Antigravity is enabled or
installed; it never stops you from keeping it enabled or turning it off.
