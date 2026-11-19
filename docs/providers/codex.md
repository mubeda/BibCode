# Codex

Install the Codex CLI, make sure `codex` is on the BiBCode server's `PATH`, and
sign in:

```bash
codex login
```

For one account, the default provider instance needs no custom home:

```text
Display name: Codex
Binary path: codex
CODEX_HOME path: empty
Shadow home path: empty
```

An empty `CODEX_HOME path` lets Codex use its normal default. BiBCode resolves
that default as `~/.codex` when grouping Codex state internally.

## Updates and version advisories

BiBCode identifies the installation from the resolved `codex` executable and
its canonical target. It does not use a separate package-manager inventory,
because another inventory can describe a different Codex installation.

- Official standalone installations use the resolved executable's `codex update`
  action.
- Homebrew cask installations use `brew upgrade --cask codex`.
- Recognized npm, pnpm, Bun, and Vite+ package-manager paths use their matching
  global-install command.

Each recognized Codex row obtains its latest-version advisory from npm's
`@openai/codex` latest document; the action is still selected from the
installation source above.

An arbitrary custom executable or wrapper is manual-only: BiBCode withholds
both its latest-version advisory and update action rather than applying a
package-manager command to an unproven installation. After an update command
exits successfully, BiBCode reprobes the same instance; it reports success only
when a fresh advisory is current or the installed version provably advanced.

## Shared state with separate authentication

Codex can use a shared home for sessions and configuration while keeping a
second account's `auth.json` in a shadow home.

First, authenticate the normal account:

```bash
codex login
```

Then authenticate the second account in a separate home:

```bash
mkdir -p ~/.codex-personal
CODEX_HOME=~/.codex-personal codex login
```

Configure two provider instances:

```text
Display name: Codex Work
Binary path: codex
CODEX_HOME path: ~/.codex
Shadow home path: empty

Display name: Codex Personal
Binary path: codex
CODEX_HOME path: ~/.codex
Shadow home path: ~/.codex-personal
```

Before starting the second instance, BiBCode prepares its shadow home. The
shadow keeps its own `auth.json` and links shared, non-private Codex state back
to the configured `CODEX_HOME`.

Do not copy or delete a whole Codex home as a troubleshooting step. Back up both
directories before changing them, and verify that the shadow directory contains
its own regular `auth.json` file.

### Current account-status limitation

The provider status probe does not currently apply the configured Codex home or
shadow home. The account email shown in Settings may therefore describe the
server's default Codex login rather than the selected shadow account. Use clear
display names, and verify the account from the Codex session when identity
matters.

BiBCode also does not currently publish the shared-home continuation group in
provider status. Existing-thread model pickers are locked to the Codex driver,
but must not be treated as proof that every displayed Codex instance can safely
resume the same provider session. Prefer the instance that created the thread.

## Default model

BiBCode has no built-in Codex model. A thread, an AI Terminal or a setting that
nobody chose a model for stores `auto`, and BiBCode then starts Codex without
naming a model, so Codex runs its own default. That default is the `model` in
Codex's configuration (`config.toml`, read with `config/read`), and otherwise
the model that `model/list` marks with `isDefault`.

The model picker lists this choice first as **Codex default**, followed by the
name of that model, for example **Codex default (GPT-6-Sol)**. When Codex
reports neither, or its list cannot be read, the entry reads **Codex default**.
A model you choose is sent as chosen.

Codex's collaboration mode (Plan) requires a model name. For a thread with no
chosen model BiBCode sends the model Codex reported when it opened the thread,
and `gpt-6.1-sol` only when Codex reported none.

Codex retired `gpt-5.4` and `gpt-5.4-mini` for ChatGPT sign-in, and its model
list no longer offers them there. A thread or a saved default that still names
one, or the aliases `5.4` and `gpt-5-codex`, is handled when it is used:

- In the app, the model picker shows **Codex default** for it. The next message
  starts without a model, stores that choice on the thread, and shows one notice
  that names the retired model.
- A message that does not come from the app (an agent message, an MCP client)
  starts the session without a model when BiBCode knows Codex is signed in with
  ChatGPT, and the thread shows one warning line. The server then stores
  **Codex default** on the thread, so the warning does not come back and the
  next message does not restart the session. It does so with the server-only
  `thread.retired-model.clear` command. It names the instance that dropped
  the model and replaces only the model, and it changes nothing when the
  thread meanwhile names another model, or the same model on another instance.
  A message
  admitted naming the retired model or an alias, before or while the session
  started, is sent on that session as admitted.
- A saved default is skipped while the list does not offer it. The next Codex
  message sent from the app saves Codex's default in its place and shows one
  notice that names the retired model.

With API-key sign-in the list still offers the model and the stored choice is
sent unchanged, with no notice. Before BiBCode has read the sign-in type, and
for any other model name that Codex refuses, the name is passed through and
Codex's own error is shown.

Switching a thread from a named model to **Codex default** restarts its Codex
session when the next message starts, because a running session cannot be told
to drop its model. Codex keeps a thread's previous model when the thread is
resumed without one, so a resume with no chosen model names Codex's default as
described above. The lookup has 5 seconds. If Codex does not answer, the resume
names no model and the thread keeps its previous one. A fresh thread names none.

## Custom endpoints and secrets

Add account-specific variables in the provider instance's **Environment
variables** section. Mark API keys and tokens as **Sensitive**. BiBCode stores
sensitive values as server secrets and does not send the value back to the app
after saving.

## Context-window usage

Codex publishes token usage only for the root thread of the current provider
session; child-thread notifications are ignored. In a normalized usage update,
`tokenUsage.last.totalTokens` is active context-window usage and
`tokenUsage.total.totalTokens` is lifetime processed usage. The optional
`tokenUsage.modelContextWindow` is the maximum context-window size. Lifetime
processed usage is displayed as context metadata and never substitutes for the
active usage meter.

Codex reports automatic context compaction with each valid usage update. The
workspace meter can therefore explain that Codex compacts context automatically
when needed, while still showing the current active usage and maximum
independently.

## Compaction and retries

Codex compacts the conversation on its own as the context fills. To compact on
demand, send `/compact` (it is in the `/` menu): BiBCode asks Codex for
`thread/compact/start` on the thread instead of sending the text to the model.
Codex runs the compaction as a turn of its own, and the work log shows it as a
**Conversation compaction** step while it runs, whether Codex or you started it.
Codex takes no instructions for a compaction, so `/compact` followed by text is
sent as an ordinary message. A `/compact` steered into a running turn is
refused and waits in the queue until that turn ends.

A turn that fails because the conversation no longer fits the model's context
window (`codexErrorInfo: contextWindowExceeded`) says that Codex ran out of
context and offers **Compact conversation**, which sends `/compact`. BiBCode
never resends the failed message itself.

While Codex retries an upstream failure (an `error` notification with
`willRetry: true`), the work log shows a warning such as "Codex is retrying
after an upstream error: …". A failure Codex does not retry ends the turn as
before.

A compaction carries no user message, so restart recovery cannot find it in
the thread: if BiBCode stops between Codex accepting `/compact` and BiBCode
recording that, the compaction is sent again after the restart.

These shapes come from the schema that `codex app-server generate-json-schema`
writes for the supported Codex version (0.164.0); the excerpts BiBCode's tests
read are in `apps/server/tests/fixtures/codex`.

## Reasoning summaries

The root thread's reasoning summaries show in the chat as collapsed **Thought**
rows, one per reasoning item (see the
[Workspace UI](../user/workspace-ui.md#reading-the-timeline)). Each
`item/reasoning/summaryTextDelta` streams into its item's row, and a part after
the first starts after a blank line. The item's `item/completed` carries the
whole `summary[]`, joined the same way, and replaces what streamed, so a stream
that lost or cut parts still ends with the complete summary; a summary that
streamed nothing is shown from its completion. Raw reasoning
(`item/reasoning/textDelta`, an item's `content[]`) is never shown or stored.
BiBCode sends no `summary` setting, so Codex's own `model_reasoning_summary`
applies. The Subagents surface keeps its own **Reasoning summary** entries.

## Steering a running turn

While Codex is working, Enter adds a queued message. **Steer** on the first
card, or `Mod+Shift+Enter` in the composer, sends it through Codex `turn/steer`
with the active turn ID. Codex injects it at that turn's next boundary. The
message joins the running turn, and Stop continues to target that same turn.

If steering is rejected or the turn is no longer available, the message returns
to the queue with the reason on its card. It can start normally when the session
is ready; interruptions and errors keep queued messages on hold until you use
**Send now**. See [Queued messages](../user/workspace-ui.md#queued-messages) for
cancellation, attachments, and reload behavior.

## Reverting to a checkpoint

**Revert to this message** first asks Codex to drop the newer turns from its
conversation history. Only after that succeeds does BiBCode restore the
workspace files from its own Git checkpoint refs, so a refused rewind changes
nothing (see
[Checkpoint revert](../architecture/rpc-and-orchestration.md#checkpoint-revert)).
Codex never restores files.

Rewinding needs **Codex 0.151.0 or later**. BiBCode rewinds only with
`thread/revert`: it pages newest-first through `thread/turns/list`, then sends
`thread/revert` with the ID of the oldest turn to drop as `beforeTurnId`. When
Codex holds fewer turns than BiBCode is dropping, every remaining turn is
dropped. `thread/revert` arrived in Codex 0.148.0 but rewinds only threads with
paginated history, and Codex 0.151.0 is the first to create those by default.

Codex reports each thread's `historyMode` in its `thread/start` and
`thread/resume` responses. BiBCode checks it before asking for anything, and a
revert it cannot do fails without changing anything:

- No `historyMode` means a Codex that predates history modes. The work log
  asks you to update Codex to 0.151.0 or later and then start a new thread. A
  Codex that rejects `thread/revert` as an unknown method gets the same advice.
- `legacy` means a thread that cannot be rewound: one an older Codex started,
  or any thread on a Codex before 0.151.0. The work log asks you to start a new
  thread on Codex 0.151.0 or later.

## Code reviews

A Codex chat review (Source Control → **Review changes**) runs with
`approvalPolicy: never` and Codex's read-only sandbox on `thread/start`,
`thread/resume` and every `turn/start`, whatever runtime mode the review thread
stores. This is the policy of the Codex terminal review. Codex may read the
checkout and run commands the sandbox allows without asking; a command that
needs to write fails back to the model. If Codex still sends a command
approval, a file-change approval or a question, BiBCode declines it at once and
no card opens. The sandbox is Codex's own: the user's Codex configuration, MCP
servers and hooks still load, and BiBCode adds no limit on readable paths or
network beyond it. See [Runtime modes](../architecture/runtime-modes.md#codex-code-reviews).

## Activity observation

Structured Codex chats run through `codex app-server`. BiBCode uses App Server
events for live activity and feature-detects optional reconciliation methods such
as descendant-thread, history, and background-terminal discovery. Unsupported
methods degrade the affected activity view instead of inventing data.

Chats and observed provider terminals both initialize the App Server with
`capabilities.experimentalApi: true`. `thread/backgroundTerminals/list` is
experimental in the
[App Server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/common.rs),
as are `thread/backgroundTerminals/terminate`, `thread/backgroundTerminals/clean`,
and `thread/items/read`; see the
[App Server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md).
The `subAgentActivity` item was experimental-only in Codex 0.163 and is part of
the stable schema (`codex app-server generate-json-schema`) from 0.164.0.
Without the experimental API, background-terminal discovery is the part that
degrades.
BiBCode lists background terminals but never terminates or cleans them, so
Activity offers no Stop for a Codex background terminal.

BiBCode accepts validated `subAgentActivity` items as bounded child-discovery
hints and direct-reads those child thread IDs: thread metadata from
`thread/read` without turns, then the newest 20 turns from
`thread/turns/list`. This remains effective when an
App Server version, including Codex 0.146, omits spawned children from
`thread/list`; listing remains enabled as a complementary discovery source for
versions that expose it. That omission was last measured on 0.146; later
releases, whose `thread/list` filters by source and working directory, have not
been re-measured. Malformed or out-of-scope hints are ignored. When read
and list methods are incompatible, recovery capabilities downgrade truthfully
without disabling ordinary chat. Only a missing-method answer counts as
incompatible: a large or undecodable reply to any reconciliation method is a
failed read, retried on the next pass. Restart reconciliation of a durable
delivery pages `thread/turns/list` newest first for the delivery key's
`userMessage.clientId`. It reports the message absent only after the last page;
a repeated cursor or more than 100 pages leaves the delivery unknown, so a
delivered message is never sent twice.
Valid mutations accepted before a later transient failure or same-root
reconnect remain pending until a current reconciliation publication succeeds;
replacing the root or disabling activity discards that root-owned pending state. Pending recovery coalesces superseded
record states while preserving retained per-actor chronology, and orders each
parent state before the child or reparent state that depends on it. Unsortable
or cyclic topology stays pending behind a runtime warning. Valid publication is
split into bounded events; the first carries scope and health, and only
successfully queued event prefixes are acknowledged.

Provider-terminal activity is also capability-gated. BiBCode probes the
configured executable before adding its private remote-observation arguments. If
the required switches are unavailable or preparation fails safely, the original
Codex terminal command runs without structured terminal activity.
Provider-terminal reconciliation remains list-based: `subAgentActivity` can
trigger a bounded list pass but cannot create a provisional terminal-scope actor
or opt that observer into structured-chat direct-read recovery.

In structured chats, BiBCode exposes targeted Stop capability only for a
canonical verified child thread with one currently active turn. The private
child `threadId` and `turnId` can be recovered from validated live or
reconciliation lifecycle data and are removed on matching completion. Root,
provisional, stale, conflicting, terminal, malformed, and oversized targets are
rejected without falling back to the root composer interrupt, terminal cleanup,
or operating-system process termination. Provider-terminal Activity remains
read-only.

After revalidating the private handle against the current session and Activity
generation, BiBCode sends App Server `turn/interrupt` with that exact child
`threadId` and active child `turnId`. It never substitutes the root thread or
routes the request through the composer Stop path. Interrupt acknowledgement
records delivery only: subsequent App Server lifecycle events decide whether
the actor is interrupted, cancelled, completed, or failed. Subtree retries stay
inside the original server-owned fence and send only active residual or late
descendant handles that are still exact.

See [Activity observation](../architecture/activity-observation.md) for the
shared protocol and provider matrix.
