# Antigravity

Antigravity is a **Preview** provider and is disabled by default. Turn it on in
**Settings → Agents** when you want it. Until then BiBCode does not probe the CLI
and shows no Antigravity entry in the chat or terminal menus.

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

Sign in inside the CLI itself, by running `agy`. BiBCode never handles your
credentials. If you are not signed in, Settings and the chat report that state
and tell you to sign in first.

## Settings

Enable the Antigravity card in **Settings → Agents** and, if `agy` is not on the
server's `PATH`, set **Binary path**. The default is `agy`.

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

BiBCode never answers a permission request for you, in any mode. A request the
CLI sends is always shown to you. When you change the mode while the agent is
working, the change applies once the CLI confirms it; use **Stop** to end the
turn at once. If the CLI does not confirm a mode, the next message is refused
until it does.

## Terminal

The Antigravity Terminal starts the CLI with `--dangerously-skip-permissions`,
like the other provider terminals start their CLIs in their bypass mode. The CLI
then runs tools in that terminal without asking. The chat never uses that flag.

The first run of the CLI in a workspace asks a few questions in the terminal.
Answer them there; BiBCode does not answer them for you. It is simplest to open
an Antigravity Terminal once before the first chat.

## Usage in the status bar

Turn on **Antigravity usage** in **Settings → Status bar** to see the five-hour
and weekly limits the CLI reports, for each model group, with their reset times.
BiBCode reads them with `agy -p "/usage"`, which sends no prompt, at most every
five minutes; the refresh button reads at once. It needs CLI version 1.1.11 or
later and an account sign-in: with an API key there is no account quota to show.
BiBCode reads only the built-in Antigravity instance.

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

## Why it is Preview

Google was not asked about its terms of use for third-party hosts, so
Antigravity ships as Preview. BiBCode runs your own unmodified CLI with your own
sign-in. Read Google's [Antigravity FAQ](https://antigravity.google/docs/faq) and
the [ACP page](https://antigravity.google/docs/cli/acp) before relying on it, and
check which plan covers your use.
