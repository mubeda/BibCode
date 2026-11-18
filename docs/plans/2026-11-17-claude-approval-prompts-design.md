# Claude approval prompts in chat threads

Status: design for issue 383, written 2026-11-17 and revised the same day after the Codex and
advisor reviews. The section "Changes after review" lists what they changed.

## Problem

A Supervised Claude chat thread never shows an approval card. BiBCode starts Claude Code with
`--print` and no permission prompt target, so Claude denies by itself every tool that needs
approval. The approval card, its "Always allow this session" button and the Claude runtime's
`open_permission_request` exist, but nothing in production opens a request.

Measured on Claude Code 2.1.326 on 2026-11-17, with the launch arguments BiBCode uses:

- Without `--permission-prompt-tool stdio`, a Bash command that needs approval comes back as a
  failed tool result and is listed in `permission_denials`. No request reaches the host.
- With the flag, Claude writes `{"type":"control_request","request_id":…,"request":{"subtype":
  "can_use_tool","tool_name":…,"input":…,"permission_suggestions":[…],"tool_use_id":…}}` and
  waits for a `control_response` with that `request_id`.
- A reply of `{"behavior":"allow"}` runs the tool. The same reply with `updatedPermissions`
  (the suggestions, each with `destination` set to `session`) makes a second identical command
  run without a prompt, and writes no settings file.
- With the flag, `ExitPlanMode` and `AskUserQuestion` also arrive as `can_use_tool` requests and
  wait.

## Decision

Pass `--permission-prompt-tool stdio` and answer `can_use_tool` requests from the approval card.

| Request           | Handling                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AskUserQuestion` | Opens the existing question card (`open_user_input_request`). The answer is sent as an allow whose `updatedInput` carries the questions and the answers.                                                             |
| `ExitPlanMode`    | Denied at once with a message that the person reviews the plan in BiBCode. This keeps the plan review as it is today, where Claude's own denial ends the turn and BiBCode shows the plan it read from the tool call. |
| Any other tool    | Opens an approval card (`open_permission_request`) with the tool name, the input and the suggestions.                                                                                                                |

The request id of a card is Claude's own `request_id`, so the reply needs no mapping.

Replies:

- Approve once: `{"behavior":"allow","updatedInput":<the input Claude sent>}`.
- Always allow this session: the same, plus `updatedPermissions`. Only `addRules` with behavior
  `allow` and `addDirectories` are kept, each with `destination` forced to `session`. A
  suggested `setMode` is dropped, because it would change the permission mode while the thread
  still shows the one the person chose. With nothing left, the reply is a one-time allow and the
  resolved event carries the reason.
- Decline and Cancel turn: `{"behavior":"deny","message":…}`. Cancel turn also interrupts, as
  it does today.

Lifecycle:

- `control_cancel_request` from Claude closes the card as cancelled.
- A reply for a request that is no longer pending is not written.
- When the Claude process exits or the turn ends, the engine's existing handling of open
  requests applies. Pending requests are already part of the runtime's reconnect snapshot.
- The flag is sent only when the capability probe finds `--permission-prompts` in `--help`. An
  older CLI keeps today's behavior.
- Full access uses `bypassPermissions`, so it opens no card.

## Alternatives

1. Keep the reply fix only. The button label stays untrue for Claude, because no card opens.
2. A `PermissionRequest` hook that calls back into BiBCode. It needs a second channel and a
   blocking hook process per request. The stream channel is the one the Agent SDK uses.
3. Let `ExitPlanMode` open a card. It changes the plan review flow, which has packaged tests.

## Trust and data

The tool input in a request is provider data. It is shown in the card, as for other providers,
and never interpolated into a command. Approval payloads and tool input do not reach profiler
records or logs. Session rules never leave the session: a destination that names a settings file
is rewritten.

## Tests

- Runtime tests for each decision and each suggestion shape.
- A driver test with a scripted Claude: a `can_use_tool` request opens a card, the session
  approval writes a `control_response` with session rules, a second matching request from the
  script is answered the same way only after another decision, `AskUserQuestion` opens the
  question card, `ExitPlanMode` is denied without a card, and `control_cancel_request` closes
  the card.
- A launch-argument test for the probe gate.

## Changes after review

Measured on Claude Code 2.1.326 after the first draft:

- Without the flag, plan mode has no `ExitPlanMode` tool at all ("No such tool available") and
  the turn ends with the plan as text. With the flag the tool exists and asks. The denial
  message therefore tells Claude to end its turn, which keeps the outcome.
- A read-only command in plan mode (`git diff --stat`) runs without a request with and without
  the flag, so a Claude Source Control review does not start stopping on cards for reads.
- An interrupt while a request is pending makes Claude send `control_cancel_request` for it.
- A deny with `interrupt: true` ends the turn.
- An answered `AskUserQuestion` reads the answers from `updatedInput`.

Changes to the design:

- The approval card shows a `detail` line: the command, or the tool with its file or target.
  Before, a Claude card would have named only the request kind.
- A decision, Claude's cancel request, an interrupt and session shutdown each claim the pending
  request, and only the first claim wins. A later answer is refused with "Unknown pending
  approval request", which the client reads as a stale card, and nothing is written.
- The driver publishes the resolved event after the reply is written, so the card closes and
  the one-time fallback reason reaches the thread. It holds a weak sender, so it does not keep
  the event stream open after Claude's output ended.
- The decision names are the app's: `accept`, `acceptForSession`, `decline`, `cancel`. `cancel`
  denies with `interrupt: true`.
- A request records the turn that asked. Its resolved event names that turn.
- Reply writes are bounded by the interrupt deadline, and a reply the runtime gives by itself
  (`ExitPlanMode`) is written off the output loop.
- The flag is passed in every permission mode, because Claude sends tools that need the person
  (`AskUserQuestion`) to the host in `bypassPermissions` too.

Changes after the second review:

- A request that is still open when its turn ends is closed with the turn, so a late answer
  from another client is refused.
- A reply that cannot be written ends the session instead of leaving Claude waiting. Shutdown
  hands its cancellations to the event queue without waiting, because the supervisor stops
  reading events before it shuts a driver down.
- A session rule keeps only its valid entries. The one-time fallback reason is the `detail` of
  the resolved row, which is the line the thread shows.
- A question's options always carry a description, because the question card shows only
  options that have one.

Known limits:

- If Claude exits after it read a reply and before BiBCode published the resolved event, the
  card can stay visible until the thread is reloaded.
- The collapsed approval card on a narrow viewport does not show the command. That is true for
  every provider.

- The card does not show the scope of the session rule Claude suggested.
- A reply that times out after part of it was written can leave a broken frame on Claude's
  stdin. The session then fails and is restarted by the existing recovery.
- A launch whose capability probe timed out gets no flag, as for the other probed capabilities.
- The runtime's reconnect snapshot is not used in production and was left as it is.
