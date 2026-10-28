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
`isAutoCompactEnabled` as the automatic-compaction indicator, and
`autoCompactThreshold`, when present, as `autoCompactTokens`: the context size at
which Claude compacts automatically (about 967K on native 1M-token models). The
context meter names it. The response is applied only while the completed turn
is still current; late responses for an earlier turn are rejected.

Unsupported, malformed, timed-out, cancelled, EOF, or write-failed control
queries are nonfatal. They leave the last good stream/result-derived context
usage in place and release completion without waiting longer. Pending control
response waiters are removed on timeout and shutdown. Accumulated totals in
Claude result messages are lifetime processed metadata only; they never replace
active context-window usage.

## Compaction and the context limit

Claude reports a compaction, automatic or from `/compact`, with `system`
`status` messages: `status: "compacting"` while it runs, then another status
(`null` or `requesting`) with `compact_result` (`success` or `failed`) and, on
failure, `compact_error`. BiBCode shows it in the turn as a **Conversation
compaction** step, failed with Claude's reason when compaction fails, so a
compaction near a full 1M-token window (often over a minute) does not look like
a stalled turn.

When a conversation no longer fits, Claude ends the turn with a context-limit
`terminal_reason` (`blocking_limit`, `prompt_too_long` or
`rapid_refill_breaker`) after a synthetic assistant message whose `error` is
`invalid_request` and whose text is `Prompt is too long` (or `Prompt is too long
· automatic compaction failed: <cause>`). BiBCode fails that turn with the
`context_limit` error class and the message "Claude's context window is full.
Compact the conversation, then send your message again.", followed by Claude's
text. The failure also reports two facts that BiBCode reads from Claude's raw
output, never from that message: `beforeOutput` (Claude refused the turn's
input before any assistant text, tool call or compaction) and
`compactable: false` for `rapid_refill_breaker`, for `automatic compaction
failed:` (Claude's documented "`/compact` fails on the same error until you
do"), and for the single-exchange form, where compacting cannot help.

When the failed turn did nothing first, compaction can help, and Claude's own
auto-compact switch is on (its latest context-usage reading of this
conversation says `isAutoCompactEnabled`), BiBCode recovers on its own, once:
the error reads "The context window is full. Compacting the conversation, then
sending your message again.", BiBCode compacts the conversation, and once that
succeeds it sends a copy of the message, labelled "Sent again after the
conversation was compacted." A copy that fails at the limit again, a failed or
stopped compaction, or Claude's auto-compaction turned off
(`autoCompactEnabled: false` or `DISABLE_AUTO_COMPACT`, which turn
`isAutoCompactEnabled` off; `DISABLE_COMPACT` is expected to as well, which no
recorded response confirms yet, so BiBCode also reads either variable from the
provider instance's environment as auto-compaction off) ends at the error
above, with the manual action. See
[Context-limit recovery](../architecture/rpc-and-orchestration.md#context-limit-recovery).

Before sending a message, BiBCode also compacts first when the latest reading
of the conversation is within 5% of the window of Claude's own compaction point
(`autoCompactThreshold`), so one large message cannot cross both points at once,
as in #160. To leave Claude more headroom instead, set
`CLAUDE_CODE_AUTO_COMPACT_WINDOW` (or `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`) in the
provider instance's environment variables; BiBCode passes no auto-compact
window of its own, so the user's and an administrator's settings stand.

The thread's error, titled "Claude ran out of context", offers **Compact
conversation**. It dispatches `thread.compact`: BiBCode writes `/compact` on
stdin and opens a turn of its own for it, tagged with the compaction id. The
write is registered for acknowledgement like a delivery's, without an outbox
row; the turn awaits its input, so a successful `result` Claude reports first
after a resume is ignored, and only the `local_command: "compact"` result ends
it. The compaction succeeded only when that turn completed with a completed
**Conversation compaction** step; "Not enough messages to compact." is a
failure, and the error then keeps its context-limit class, so **Compact
conversation** stays to try again. The action is disabled while the thread is
working or a compaction is unsettled. Against an older server, without
`supportsCompaction`, it sends `/compact` as an ordinary message instead
(Claude only; other providers are not offered the action). Typing `/compact` in
the composer still sends it as a message.

Other failed turns prefer, in order: the result's `errors`, the text of
Claude's synthetic error message (an `authentication_failed`,
`oauth_org_not_allowed`, `verification_required` or `cloud_credential_error`
error is classed `permission_error`), the upstream API error Claude was
retrying, and finally `Claude turn failed (<terminal_reason>, HTTP
<api_error_status>).`. Every documented `terminal_reason` is listed in one
table in `apps/server/src/provider/claude/failure.rs`; a reason missing from it
is shown by name. These shapes were checked against Claude Code 2.1.306.

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

## Model options

The Claude session applies three model options:

- **Reasoning** (`effort`), passed to Claude as `--effort`;
- **Fast Mode** (`fastMode`), passed in the session settings. Turning it on
  needs a model that offers it: one Claude reported with Fast Mode, including
  aliases such as `opus`, or, for a model Claude did not report, one BiBCode's
  built-in catalog offers it for. Turning it off is always accepted;
- **Agent** (`agent`), passed as `--agent` and listed from the agents Claude
  reports.

Models and their options normally come from Claude's session initialization.
When Claude reports no models there, BiBCode offers its built-in catalog, which
lists only the options above. A turn whose options the session refuses, for
example one saved while an older catalog offered another option, is not retried:
its delivery fails once and the thread shows **Delivery failed** with the
reason, such as "Fast Mode is not supported by the selected model." Choose
another model or option, then send the message again.

## Steering a running turn

Steer sends the head queued message to Claude while it is working. Claude can
consume it at the next tool boundary. If no tool boundary is available, Claude
finishes the current reply first, then immediately consumes the message as its
next turn.
Steer therefore does not guarantee that a reply without tool calls will change
before it finishes.

BiBCode marks the message delivered when the running Claude process replays the
same input text, including when that replay arrives after the current reply's
`result`. Image blocks alongside the text do not prevent acknowledgement;
image-only messages are acknowledged too. A replay containing any tool-result
block, or different text, is not an acknowledgement.
A local command such as `/compact` is not replayed; Claude reports it with a
`result` naming the command (`local_command`), which marks it delivered and ends
its turn. While Claude compacts the conversation, before reading a message or
for `/compact`, the 60-second confirmation wait is paused and then restarts.
The acknowledgement remains pending for the lifetime of that process, even
across turn completion. The message is attributed to the BiBCode runtime turn
current when the echo arrives, without allocating a new turn for the steer.
The card can remain **Steering…** while Claude finishes the earlier reply. You can
keep composing and queueing messages while it waits. If the process or session
is replaced before a matching replay arrives, delivery is uncertain; BiBCode
does not automatically resend it. A steer rejected before writing, or whose turn
is unavailable, returns to the queue with its reason on the card. Interrupts and
errors keep queued messages on hold until you use **Send now**. See
[Queued messages](../user/workspace-ui.md#queued-messages) for queue controls.

## BiBCode tools

Each Claude chat session gets the BiBCode MCP server (`bibcode`) with a
credential scoped to its thread. BiBCode writes that server's configuration,
bearer token included, to a file only your user can read (mode `0600` on Linux
and macOS, an owner-only access list on Windows) in the system temporary directory and passes the file's path to
`--mcp-config`, so the token never appears on Claude's command line, where any
local process could read it. The file is removed when the session ends. The
server's MCP URL uses loopback (`127.0.0.1`) even when BiBCode listens on every
interface.

The credential is a random token that exists only in the running server's
memory, as a hash. It expires after eight hours, is replaced when a message
starts the thread's session again after it was suspended or stopped, and is
discarded when BiBCode quits. To retire a token that may have been exposed, quit
and restart BiBCode, or stop the thread's session and send it a new message.

## Tool calls in the thread

BiBCode runs Claude with partial messages, so Claude streams each tool call's
input as fragments of a JSON document (`input_json_delta`). BiBCode collects the
fragments of each tool block, by its subagent stream and block index, and
records the complete input once, when the block ends: the thread gets one
update with the tool's input, not one per fragment, and the tool's completion
carries the same complete input. Versions before 0.11.0 recorded an update for
every fragment; threads keep those activities and still load them.

The tool's result, such as a command's output or a file it read, is recorded
on the same update and completion. A result whose JSON is larger than 16 KiB is
recorded as a preview: the first 16 KiB of its text, followed by
`[Tool result truncated by BiBCode]`. Images and other parts of such a result
that are not text are left out. A thread's records are replayed to every
client that opens it, so a command that printed megabytes is not sent with
every replay; the full result stays in Claude's own session transcript. Codex
and Cursor already leave command output off their records.

## Terminal sessions in History

The composer's **History** button lists the Claude Code sessions run with
`claude` in a terminal in the thread's folder (its worktree, or the project
root) in the last 30 days, on the server that runs BiBCode. Sessions started
with `claude -p`, by an Agent SDK, by the Desktop app, or by BiBCode itself are
left out, and so are sessions another BiBCode thread already runs. A row shows
the name you gave the session with `/rename` (or the one Claude generated),
else its first prompt, with its branch and last activity.

- **Continue** opens the session as a chat panel of the thread, in the
  thread's branch, worktree and permission mode, with up to 200 of its
  messages. Your next message runs `claude --resume <id>` in that folder, so
  the terminal and the panel share one conversation from then on. Don't resume
  it in a terminal again while the panel uses it: both would write to the same
  transcript.
- **Continue in a copy** is offered instead whenever the session may still be
  open in a terminal (Claude Code's running-session files say so, or BiBCode
  can't read them completely), when an earlier chat of it was deleted, or when
  Claude Code refused to resume it here. The panel runs
  `claude --resume <id> --fork-session --session-id <new id>`, under an ID
  BiBCode chose, and the terminal's conversation is left untouched. A copy
  needs Claude Code 2.0.73 or later; on an older one the row asks you to
  update it.
- **Open** shows a session you already continued.

If Claude Code ends a resumed session's launch with an error before it starts
(for example, because the session is still running in the background), the
message fails with "Claude Code couldn't continue this session here", and
History then offers **Continue in a copy** for it. If a copy ever comes up
under a session ID BiBCode did not choose, its message fails before any answer
is shown, and the next message tries the copy again.

## Background work and idle suspension

BiBCode suspends an idle chat session 60 seconds after its turn ends and
resumes the same conversation on the next message. A Claude session is not idle
while Claude still runs work outside a turn: `run_in_background` Bash commands,
Monitor watches, background subagents, or MCP calls Claude moved to the
background. Claude reports these on its stream-JSON output, with or without hook
events and whatever the Chat Activity setting, in `system` messages
(`task_started`, `task_progress`, `task_updated`, `task_notification`, and
`background_tasks_changed`, which carries the complete live set in Claude Code
2.1.203 and later; see the
[Agent SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript)).
BiBCode counts tasks that are neither foreground nor `ambient` and keeps the
session while the count is non-zero and Claude has written something in the
last 30 minutes.

When a background task finishes, Claude answers it in a turn it starts itself:
a `user` message and a `result` whose `origin.kind` is `task-notification`.
BiBCode gives that answer a turn of its own, so the thread reads running and
idle suspension waits for its result. Between the finished task and that turn
the session stays busy. When the task finishes during another turn, Claude can
replay its notification just before that turn's `result`; BiBCode then starts
the answer's turn as that `result` ends the first one, so the idle deadline the
`result` arms cannot stop Claude while it answers. This holds for `/compact`
too, which Claude never replays: a notification that arrives while a delivered
message awaits its replay starts its answer's turn once the message is replayed
or, for a local command, acknowledged by its `result`. An interrupted turn
starts no answer.

If a session was stopped while background work ran (for example by an earlier
version of BiBCode), resuming it makes Claude deliver the stopped tasks'
notification first. Claude can report that turn's `result` before it reads the
new message; BiBCode ignores that `result` and logs `ignored a Claude result
that arrived before the turn's input was read`, then the new message runs as
its own turn.

## Activity observation

BiBCode detects Claude activity features from the configured executable instead
of promising support for an indefinite version range.

For structured chat, it probes `--version` and `--help`. Hook activity is enabled
only when help advertises both exact switches:

- `--include-hook-events`
- `--forward-subagent-text`

If either switch is unavailable or the bounded probe fails, Claude still runs in
its normal stream-JSON mode without structured hook activity. The same probe
tells whether **Continue in a copy** can run: version 2.0.73 or later with
`--fork-session` in its help.

`--help` stays the gate even though the
[CLI reference](https://code.claude.com/docs/en/cli-reference) warns that it
does not list every flag. Claude Code
[reports an invalid flag before the run starts](https://code.claude.com/docs/en/headless),
so launching with a switch the executable lacks would break every Claude chat,
while a probe that misses a switch only turns Activity off. Version numbers
cannot replace the probe: the CLI reference and
[environment variables](https://code.claude.com/docs/en/env-vars) document
`--forward-subagent-text` (and `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT`) from
v2.1.211, and forwarding at every nesting depth from v2.1.219, but
`--include-hook-events` has no documented minimum and no environment variable,
and the `system/init` `capabilities` list names neither. `--version` cannot
test a switch either, because it answers even after an unknown flag. If a later
`--help` stops listing a switch, Claude chats keep working without structured
hook activity.

Activity creates Claude actors only from `SubagentStart` and `SubagentStop`
hooks for Agent and legacy Task invocations. The
[Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript) task messages
(`task_started`, `task_updated`, `task_notification`, and, from v2.1.203,
`background_tasks_changed`) feed the turn follow-up tracking described above,
which skips tasks marked `ambient`, and the targeted Stop correlation below for
agent tasks. No task message creates an Activity record, so background Bash
commands and
Monitor watches (`task_type: "local_bash"`) never appear under **Background
tasks**, Claude claims no background-work capability, and Activity reads
neither `run_id` nor `parent_task_id` (Agent SDK v0.3.292).

The probe runs the executable exactly as the launch will. It resolves
**Binary path** on the launch's `PATH`, including the open-url `PATH` prefix,
and runs that resolved path, never its symlink target. It runs with the
launch's environment and in the chat's working directory. This matters for
multi-call shims such as mise's `shims/claude`, a link to the `mise` binary.
mise picks the Claude it runs from the name it was called by, and from the
directory's configuration. Called by its real name, mise answers as itself.

A launch waits up to two seconds for the probe. The probe itself may run for up
to five seconds, so a slow first `--help` still records its answer for the next
launch. BiBCode caches only a probe in which both commands answered and
`--version` printed a Claude Code version (`2.1.311 (Claude Code)` or the bare
`2.1.311`) on one of its first five lines. Those lines can include a wrapper's
banner and Node's warnings on stderr. The cache key is the resolved path plus
the canonical target's identity and the parsed version, never the raw output.
Another program's answer, such as mise's `2026.10.19 linux-x64 (…)`, is a
mismatch: BiBCode does not cache it and skips `--help`. A failed or timed-out
probe is not cached either, so the next launch probes again instead of running
without the switches for the life of the server.

A resolved path is a **shim** when it is a link with a different file name
from its target, and the target is not a Claude install. A target counts as a
Claude install when its name starts with `claude` (`claude`, `claude.exe`), is
npm's `cli.js`, or is a bare version such as the native installer's
`versions/2.1.312`. Those targets change identity when Claude updates, so
their identity is enough. mise's `shims/claude`, a link to `mise`, is a shim:
its own identity does not change when the Claude behind it does.

For a shim, the key also holds the working directory. Each later launch reruns
`--version` alone, bounded by the same two seconds. Launches of one shim share
that recheck, but only when they have the same environment, since an
environment can select a different Claude. A recheck that ended without an
answer is started again. A cached answer is reused while the parsed version is
unchanged; a new version runs the whole probe again. A recheck that fails or
times out proves no change. The launch then keeps the cached answer and logs
`Claude shim did not confirm its probed version`.

The cache assumes `--help` depends only on the Claude version a shim
dispatches to. The working directory is part of a shim's key, but the
environment is not. Script shims are not detected, since they are files rather
than links: asdf, proto and Scoop shims are examples. Their identity is the
script's, so a Claude update behind such a shim shows only after a BiBCode
restart, or once the cache entry is evicted.

Each probe run writes one line to `server.log`, with the resolved
`executable`, its `canonical` target and the `search_path` it was resolved on.
All three are passed through the Profiler's path redaction, which replaces the
home directory and secrets. The line is one of these:

- `Claude activity probe finished`, an `info` line with `outcome` (`supported`
  or `unsupported`), the version and the elapsed time.
- `Claude activity probe found another program`, a warning with
  `outcome = "mismatch"` and the start of the version output, redacted and cut
  to 256 bytes.
- `Claude activity probe failed`, a warning with `outcome` (`failed` or
  `timed out`) and the reason.

A launch that stops waiting for the probe logs
`launching Claude without activity flags`. A session restarted in the same
server process takes its activity capabilities from the new process, also
while Chat Activity is off. When that process has no hook support, retained
subagents show as stale. They do not stay
live (see
[Activity observation](../architecture/activity-observation.md)).

## Thinking

Claude's thinking shows in the chat as collapsed **Thought** rows, one per
thinking block, never as assistant text (see the
[Workspace UI](../user/workspace-ui.md#reading-the-timeline)). From Claude Opus
4.7 on, the API omits thinking text unless a client asks for a summary; older
models summarize by default. The same probe therefore asks whether the CLI
accepts `--thinking-display summarized`, a switch `--help` does not list: it runs
`claude --thinking-display bibcode-probe --version`. A CLI that knows the switch
rejects the invalid value, exits nonzero and names `summarized` among the values
it allows; only then is the switch passed to chat launches. A CLI without it
ignores the option under `--version` and exits 0, and reads as unsupported. A
timed-out or failed run is not cached, as for the other switches, and the probe
line in `server.log` reports `thinking_display`.

The switch only asks for text. What BiBCode shows never depends on the probe:
any non-empty thinking delta becomes a thought, and an omitted block (one empty
delta and a signature), a redacted block or a subagent's thinking adds no row.
Summarized thinking delays the first text token of a reply a little, which is
the cost of seeing the thoughts.

Structured chat control correlation is stricter than display observation.
BiBCode exposes a private task target only after one session and Activity
generation proves the complete identity chain: an Agent/legacy Task tool
invocation, its authenticated asynchronous PostToolUse result carrying the
same `tool_use_id` and `agentId`, a `task_started` record carrying that
`tool_use_id` and `task_id`, and the matching `SubagentStart` `agent_id`.
`task_type` may be absent or exactly `local_agent` or `remote_agent`; every
other value fails closed.
Root invocations require both the stream invocation and authenticated hook to
identify the root as their source and `SubagentStart` to report no parent. A
nested invocation additionally requires its stream `parent_tool_use_id` to
resolve to an active exact parent correlation whose launched `agentId` equals
the nested authenticated PostToolUse hook's top-level source `agent_id`; the
exact PostToolUse `agentId` names the child. Documented `SubagentStart` hook
payloads do not include `parent_agent_id`; after the exact source proof, BiBCode
privately reparents that named child to the source parent. If a future payload
does include explicit lineage, it must agree. Root/nested mismatch, sibling
cross-wiring, conflicting lineage, or mismatched source ownership never enables
control. A bounded dependency fixpoint settles already-present parent, child,
and deeper chains in one observation regardless of lexical identity order.

The complete PostToolUse chain is the authoritative path. When a nested Claude
version provides no usable PostToolUse launch result, an authenticated
`PreToolUse` from an already exact parent instead opens a parent-owned pending
interval. The nested-only parent-local fallback admits control only when the
stream parent tool, the accepted nested `task_started` candidate, and the
unmatched verified child are globally unique, with no unresolved root launch
that could own the child. The correlator then privately assigns that child to
the exact source parent. A later exact PostToolUse result promotes that pending
state to an exact target or contradicts it, retires it, and tombstones its
identity chain so replay cannot recreate the target. Multiple nested candidates,
multiple unmatched children, or any unresolved root launch remain observable
but unsupported and cause zero provider I/O; BiBCode does not infer identity
from text, timing, order, proximity, or transcript contents.

Arrival order is irrelevant. Every accepted fact that installs, retires, or
terminalizes a target carries a deterministic domain-separated SHA-256 event
key through the production event pump. The key is duplicate-stable, bounded,
status-separated, and contains no provider-native identity. Effect-producing
conflicts use bounded canonical classes such as asynchronous/other and
local-agent/other, so arbitrary status or type labels cannot suppress a target
retirement. Optional source and parent identities are framed as explicit
`none` or `some` plus the bounded value; the valid literal native identity
`<root>` is therefore never confused with absence. Present invalid hook source
or parent fields are rejected at the authenticated boundary rather than being
coerced to the absent/root form. Names, roles, descriptions, prompts,
timestamps, output paths, and event proximity are never correlation keys;
incomplete, conflicting, stale, malformed, or saturated chains remain
observable but uncontrollable. Live identity maps and unmatched terminal
statuses are each bounded at the Activity page limit, including the
generation-owned parent-local pending set (200 correlations). The fallback uses
no timers, polling, or transcript reads. Terminal retirement, Activity
disablement, and runtime replacement clear or retire its pending and installed
state. Terminal retirement
atomically removes the live tool/agent/task join and records generation-scoped identities in three
fixed 256-word tombstone filters (2 KiB each; 6 KiB total). Tombstones are never
evicted within a generation: a filter false positive can only disable a private
target, never create one or invent lifecycle. At exact terminal-status-map
saturation new ambiguous task facts fail closed rather than displacing earlier
terminal authority. Only bounded identities and terminal status are retained,
and provider-native IDs do not cross persistence, contracts, or logs.

A `task_notification` with status `stopped`/`cancelled`, `failed`, or
`interrupted` is authoritative Cancelled, Failed, or Interrupted lifecycle for
an exactly mapped actor and retires its private target. The runtime retains a
bounded exact terminal task-to-agent link after an ordinary SubagentStop so a
reordered authoritative task notification can still replace Completed. A later
`SubagentStop` cannot rewrite cancelled, interrupted, or failed lifecycle to
completed.

When the compatibility probe proves both hook switches and the authenticated
hook sink starts, targeted cancellation is provisionally enabled for that
structured-chat runtime generation. Clicking an actor with a complete exact
mapping or admitted nested-only parent-local fallback sends one stream-JSON
control request with subtype `stop_task` and that private `task_id`. Any
non-Claude target, root/foreground actor, ambiguous nested actor, or actor
without a current admitted mapping is rejected before provider I/O; BiBCode
never falls back to the conversation-wide interrupt request.

The control response must carry the matching request ID. Only Claude's exact
unsupported-control protocol error authoritatively disables targeted
cancellation for the current generation. Before the caller receives that
result, BiBCode removes every current Claude task handle and operation,
publishes targeted cancellation as unsupported, and cancels and reaps queued or
in-flight targeted work. Future clicks then fail without another provider
write. Generic provider errors, timeouts, malformed responses, and connection
closure remain safe operation failures and do not disable the capability. A
restarted or re-enabled runtime starts a fresh generation and may prove support
and exact mappings again. Private task IDs and raw control errors are redacted
from Activity errors, logs, and Debug output.

The Activity panel shows `Stopping` from the server's ephemeral control overlay;
the `stop_task` response itself does not terminalize the actor. Authenticated
hook and task lifecycle events remain authoritative. If only part of a selected
subtree is delivered, **Retry remaining** sends only the current exact residual
task mappings and late descendants already captured by the original
generation-scoped fence. It never performs a new semantic lookup or falls back
to Claude's conversation-wide interrupt.

Provider-terminal observation has a separate capability and safety gate. The
executable must support the required settings switches and BiBCode's additive
hook preparation. If preparation cannot be established before spawn, the
original Claude terminal command runs without structured terminal activity.

This gate differs from the chat probe above, because a prepared terminal does
not run the path BiBCode resolved. It runs a private copy of it, so that the
build BiBCode checked is the build that runs:

- **Pinning exists on macOS only.** The copy is a copy-on-write clone. Linux and
  Windows never prepare a Claude Terminal, so the probe is never reached there:
  the terminal runs the original command, its status reads **Status unavailable**
  and AI Terminal activity stays off.
- **Only the approved build is hooked.** On macOS the copy must be Claude Code
  v2.1.220 and match that build's recorded length, SHA-256 and code signature
  (`APPROVED_ADDITIVE_HOOK_VERSION`). Any other build also runs the original
  command, with **Status unavailable**.
- **A shim is never hooked.** A clone follows symlinks, so a link such as mise's
  `shims/claude` to `mise` pins a copy of `mise`, which answers as mise and is
  not an approved Claude build. The terminal then starts the shim exactly as
  configured, without the hooks. The probe reads the file that would be pinned
  (the link's canonical target), so a "not Claude" answer is never cached for a
  Claude build. A plain renamed link to a Claude build, such as
  `~/.local/bin/claude` to `versions/2.1.220`, is not a shim and is pinned
  as usual. Observing a Claude Terminal behind a shim needs the real install
  pinned and attested, which is not implemented.

Every Claude Terminal is prepared this way, whatever the AI Terminal activity
setting says, because the left panel shows its agent's status (#187). The
injected settings add these hooks to the subagent and tool hooks:

- `SessionStart`
- `UserPromptSubmit`
- `PermissionRequest`
- `Notification`
- `Elicitation`
- `ElicitationResult`
- `Stop`
- `StopFailure`
- `SessionEnd`

BiBCode only reads them: it answers each with no content, so none of them
changes what Claude does. Status decodes only the event name, session, agent,
tool name and notification type, never prompt or tool content, and follows the
main session: the first one heard, then each new `SessionStart` (`/clear` and
resume start a new session).

If the terminal cannot be prepared, its status reads **Status unavailable**.
That happens with a Claude Code older than v2.1.63 (no authenticated HTTP hooks),
on Linux and Windows (no pinning), on macOS for any build but the approved one
or when `claude` is a multi-call shim, or when the probe or settings merge fails.

See [Activity observation](../architecture/activity-observation.md) for the
shared protocol and provider matrix.
