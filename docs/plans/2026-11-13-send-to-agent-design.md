# Send to agent: a person sends a review request, a second opinion, a handoff or a message to a chosen agent

Status: Approved 2026-11-13 (approved in chat by the maintainer, including the amendments to
the messaging design listed under Constraints; after an independent read and three Codex
passes)
Size: full Mode: quick Type: feature
Source: [design brief](./2026-11-13-send-to-agent-brief.md), approved 2026-11-13. Builds on the
approved [agent messaging design](./2026-11-13-agent-messaging-design.md) ("the messaging
design"). Verified at `a9938193b` (`main`).

## Problem

A person running several agents in one project cannot act on another agent from the panel
or terminal they are in. Asking a running agent for a review, getting a second opinion,
handing work over, or continuing here after an agent ran out of tokens all mean opening the
other thread and copying text by hand. The only one-click path today is the Source Control
panel's Code review button, which always starts a new reviewer. The messaging design lets
agents message each other, but there the person can only ask their own agent to do it, and
that agent picks the recipient and rewrites the words.

## Goals

1. From a chat panel or an AI Terminal, the person sends one of five actions to an agent
   they pick, in one flow, without pasting context. Checked by R1 to R10.
2. The person sees what is attached and can cut it before sending. Checked by R5.
3. A review or a second opinion returns to where it was asked, and reaches the person's
   current agent only if they send it. Checked by R16.
4. Continuing here works when the other agent cannot answer at all. Checked by R10.
5. Every entry that cannot be used says why. Checked by R3.

## Non-goals

- Changing how agents message each other. The messaging design stands as approved.
- Typing a request or its context into a terminal's input. Terminals receive through the
  messaging design's inbox and pointer line.
- Sending across projects or environments. Decided in the brief.
- Replacing the Source Control panel's Code review button. Both stay.
- An `@agent` shortcut typed in the composer. It can be added later on the same menu.
- A summary of a thread written by a model. Handoffs are built from stored text.
- Stopping, archiving or changing the mode of any agent as a side effect of a send.

Anti-goals:

- Context from a thread other than the one the person clicked in is sent.
- A request to a terminal agent is shown as read when it was only pasted.
- An answer is delivered into the person's current agent without the person sending it.
- The person's note is lost because a send failed.

## Users and scenarios

1. As the person running a project, I want to ask an agent that already knows the code for
   a review of the work in this panel, so that I do not start a reviewer from zero.
2. As that person, I want a second opinion on my agent's last answer from another agent, so
   that I can compare before I act on it.
3. As that person, I want to hand this panel's work to another agent, so that it carries on
   there with what was done and what is left.
4. As that person, I want to continue here after another agent ran out of tokens, so that
   the work does not stop with it.
5. As that person, I want the same control in an AI Terminal, so that the kind of surface
   does not change what I can do.

## Vocabulary

| Term                                           | Meaning                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| Source                                         | The chat panel or AI Terminal whose Send to agent control was used.      |
| Target                                         | The agent picked in the menu, or the new panel it creates.               |
| Action                                         | Review, Second opinion, Hand off, Take over from, or Message.            |
| Note                                           | What the person typed for this send.                                     |
| Attachment                                     | The context an action adds below the note.                               |
| Handoff text                                   | A thread's first message from the person, then its most recent messages. |
| Answer notice                                  | The marker in the source that a review or second opinion was answered.   |
| Chat agent, terminal agent, ready for a prompt | As in the messaging design.                                              |

## Requirements

### R1. The control [Must]

The application SHALL show a Send to agent control in every chat panel's composer footer
and in every AI Terminal's toolbar, with the same five actions in both.

#### Scenario: chat panel

- GIVEN a project with two chat panels
- WHEN the person looks at either composer
- THEN a Send to agent control is beside the other composer actions and opens with the
  keyboard as well as the pointer

#### Scenario: plain terminal

- GIVEN a terminal that is not an AI Terminal
- WHEN the person looks at its toolbar
- THEN there is no Send to agent control

### R2. Picking the action and the target [Must]

WHEN the person opens the control, the application SHALL offer the five actions and, for
the chosen action, every chat agent of the project that has a provider session and is
neither archived nor deleted, every live AI Terminal of the project, and, for every action
except Take over from, a new panel with a provider the person picks; the source itself is
not listed.

#### Scenario: agents and a new panel

- GIVEN a project with a Claude panel, a Codex panel and a Codex AI Terminal
- WHEN the person opens the control in the Claude panel and chooses Second opinion
- THEN the list shows the Codex panel, the Codex terminal and the new-panel entry, each
  agent with its title, provider and whether it is busy

#### Scenario: another project

- GIVEN a second project in the same environment
- WHEN the person opens the control
- THEN no agent of the second project is listed

### R3. Entries that cannot be used say why [Must]

IF an action or a target cannot be used, THEN the application SHALL show it disabled with
the reason in words next to it and in its accessible name.

#### Scenario: the listed reasons

- GIVEN the control is open
- WHEN the person reaches an entry in one of these states
- THEN it is disabled and reads: Second opinion with no finished answer in the source
  ("No answer to review yet"); Review for a target in another worktree ("This agent works
  in another checkout and cannot see these changes"); a terminal agent that cannot be told
  it has mail ("This terminal cannot be notified of new requests"); Take over from a thread
  with no messages ("Nothing to take over yet")

#### Scenario: taking over from a terminal that cannot be notified

- GIVEN a Cursor AI Terminal, which cannot be told it has mail
- WHEN the person chooses Take over from in another panel
- THEN that terminal can be picked, because taking over sends it nothing; it is disabled
  only as a target of the other four actions

#### Scenario: an agent that is out of usage

- GIVEN an agent carrying the hint of R17
- WHEN the person picks it for Review, Second opinion, Hand off or Message
- THEN it can be picked, and the preview says it may not answer until the time shown

#### Scenario: nothing is hidden

- GIVEN an agent that cannot be a target for the chosen action
- WHEN the list is shown
- THEN the agent is still in the list, disabled, and not removed from it

### R4. The source is where the person clicked [Must]

The application SHALL take every attachment from the source and SHALL name the source in
the preview before anything is sent.

#### Scenario: two panels open side by side

- GIVEN panels A and B are both visible and B has keyboard focus
- WHEN the person uses the control in A's composer
- THEN the preview names A as the source and the attachment comes from A's thread

### R5. Preview and trimming [Must]

WHEN an action and a target are chosen, the application SHALL show the note field, the
target, the source, each attachment with its size, and what was left out, and SHALL let the
person remove or shorten an attachment before sending.

#### Scenario: trimming

- GIVEN a Hand off preview with handoff text of 18,000 characters
- WHEN the person removes the oldest part and sends
- THEN the target receives the shortened text and the note

#### Scenario: backing out

- GIVEN a preview is open and the composer held a draft before
- WHEN the person closes the preview without sending
- THEN nothing is sent, the composer's draft is unchanged, and the note typed in the
  preview is still there when the preview is opened again in that panel

### R6. Message [Must]

WHEN the person sends a Message, the application SHALL deliver the note to the target with
no attachment.

#### Scenario: empty note

- GIVEN a Message preview with an empty note
- WHEN the person looks at the send button
- THEN it is disabled with "Write a message first", and nothing can be sent

### R7. Review [Must]

WHEN the person sends a Review, the application SHALL deliver the same review request the
Code review button builds for the source's checkout and the scope picked in the preview
(uncommitted changes, or the branch against its base, with the button's default
preselected), with the note as extra instructions, and SHALL attach no diff text.

#### Scenario: new panel

- GIVEN the person picks a new panel with Codex as the target
- WHEN the review is sent
- THEN a review panel opens through the Code review button's launcher with Codex as the
  reviewer whatever the Code review agent in Settings is, with the guard that launcher
  applies for that provider, and the preview named that guard or said that this provider
  cannot be kept from editing

#### Scenario: running agent that can edit

- GIVEN the target is a running chat agent in `auto-accept-edits` or `full-access`, or any
  running terminal agent
- WHEN the preview opens
- THEN it states that this agent can change files and that the request asks it not to, and
  the person can still send

#### Scenario: same checkout

- GIVEN a source thread and a target thread whose working folders are the same path
- WHEN the person chooses Review
- THEN the target can be picked; a terminal as source or target counts with the checkout
  of the thread it belongs to

#### Scenario: other checkout

- GIVEN the target works in a different worktree
- WHEN the person chooses Review
- THEN that target is disabled with the reason of R3, and no review is sent to it

### R8. Second opinion [Must]

WHEN the person sends a Second opinion, the application SHALL attach the source's last
message from the person and the last finished answer, each cut at 16,000 characters, under
a fixed lead-in that asks for an assessment without changing files.

#### Scenario: long answer

- GIVEN the source's last finished answer is 40,000 characters
- WHEN the preview opens
- THEN it shows the answer cut to 16,000 characters and says how much was left out

#### Scenario: answer still streaming

- GIVEN the source's agent is still writing its answer
- WHEN the person chooses Second opinion
- THEN the attachment is the last finished answer, and the action is disabled with the
  reason of R3 when there is none

#### Scenario: terminal source with nothing to attach

- GIVEN an AI Terminal with no selection and no output yet
- WHEN the person opens the control there
- THEN Second opinion and Hand off are disabled with "Nothing to attach yet"

### R9. Hand off [Must]

WHEN the person sends a Hand off, the application SHALL attach the source's handoff text,
which is the person's first message cut at 4,000 characters followed by the most recent 40
messages within 24,000 characters, and SHALL leave the source's agent as it was.

#### Scenario: the task survives a long thread

- GIVEN a source thread of 300 messages
- WHEN the preview opens
- THEN the handoff text starts with the person's first message, marks the gap, and ends
  with the most recent messages

#### Scenario: the source keeps running

- GIVEN the source's agent is in the middle of a turn
- WHEN the hand off is sent
- THEN that turn is not interrupted and the source thread is neither stopped nor archived

### R10. Take over from [Must]

WHEN the person sends Take over from with another agent picked, the application SHALL build
that agent's handoff text from what BiBCode has stored, without sending anything to that
agent, and SHALL deliver it with the note to the source's own agent.

#### Scenario: the other agent cannot answer

- GIVEN agent A's thread stopped with a full context window and cannot take another turn
- WHEN the person, in panel B, takes over from A
- THEN B's agent starts a turn with A's handoff text and the note, and A's thread received
  no message and started no turn

#### Scenario: taking over into a terminal

- GIVEN the source is an AI Terminal
- WHEN the person takes over from another agent there
- THEN the handoff reaches the terminal's agent as a request under R15, never typed into
  the terminal; and Take over from is disabled there with the reason of R3 when that
  terminal cannot be notified

#### Scenario: taking over from a terminal agent

- GIVEN the picked agent is a terminal agent whose conversation BiBCode cannot read
- WHEN the preview opens
- THEN the attachment is that terminal's recent output of at most 16,000 characters, and
  the preview says it is terminal text

### R11. An AI Terminal as the source [Must]

WHEN the source is an AI Terminal, the application SHALL open the preview as its own
composer over the terminal, SHALL type nothing into the terminal, and SHALL build Second
opinion and Hand off attachments from the person's current selection in that terminal, or
from its most recent 16,000 characters of output when nothing is selected.

#### Scenario: selection wins

- GIVEN the person selected 30 lines in the terminal
- WHEN they choose Second opinion
- THEN the attachment is those 30 lines, labelled as a selection from that terminal

#### Scenario: the CLI sees nothing

- GIVEN the terminal's CLI is waiting at its prompt
- WHEN the person writes a note in the preview and sends
- THEN no character of the note or the attachment was written to that terminal

### R12. Reading a CLI's own conversation [Should]

WHERE BiBCode can read the conversation of an AI Terminal's CLI, the application SHALL
build that terminal's handoff text and last answer from the conversation instead of from
terminal output, and SHALL say in the preview which one was used; a conversation file is
read only when it belongs to the session BiBCode observed for that terminal and lies
inside that provider's own conversation folder.

#### Scenario: a path that points elsewhere

- GIVEN the CLI reported a conversation file that is a link to, or lies in, another folder,
  or that belongs to another session
- WHEN the person chooses Hand off there
- THEN the file is not read, the attachment falls back as in R11, and the preview says so

#### Scenario: fallback

- GIVEN a Claude AI Terminal whose conversation cannot be read at this moment
- WHEN the person chooses Hand off there
- THEN the attachment falls back to selection or recent output as in R11, and the preview
  says so

### R13. Delivery to a chat agent [Must]

WHEN a send targets a chat agent, the server SHALL add it to that thread's turn queue as a
new queued message from the person, so that it starts a turn when the agent is idle and
waits behind a running turn, a pending approval or a pending question; it is never taken as
the answer to a pending approval or question.

#### Scenario: idle target

- GIVEN the target is idle
- WHEN the person sends
- THEN the target starts a turn with the note and the attachment, and the source shows the
  request as read

#### Scenario: no agent rules applied

- GIVEN agent messaging is off, the target is in `full-access` and the source thread is in
  `approval-required`
- WHEN the person sends
- THEN the send is accepted: the messaging design's opt-in, runtime-mode ceiling, hop limit
  and agent envelope do not apply to a person's send

#### Scenario: another project is refused by the server

- GIVEN a request whose source, target, new panel or taken-over thread is in another
  project or environment than the rest
- WHEN it reaches the server
- THEN it is refused, nothing is queued and no context is returned, whatever the client
  showed

#### Scenario: only a signed-in person can use this path

- GIVEN a hosted agent's credential, a terminal credential, or an outside agent's MCP
  session
- WHEN it calls the person-send operation, or asks for another thread's handoff text or a
  terminal's output through it
- THEN the call is refused; agents keep only the paths and rules of the messaging design
  and of the existing outside-agent tools

### R14. Where a request came from [Must]

The application SHALL mark every message that arrived through Send to agent, in the
target's transcript, as sent by the person from the named source, with the action, and
SHALL NOT mark it as sent by an agent.

#### Scenario: attribution

- GIVEN the person sent a Review from panel "API refactor" to the Codex panel
- WHEN anyone opens the Codex panel's transcript
- THEN the message reads as the person's, with "Review, sent from API refactor", and
  carries no agent chip

#### Scenario: different worktrees, same project

- GIVEN source and target are threads of one project in different worktrees
- WHEN the person sends a Message
- THEN it is delivered and attributed the same way

### R15. Delivery to a terminal agent [Must]

WHEN a send targets a terminal agent, the server SHALL store it as a request from the
person in the messaging design's store, announce it by that design's pointer line when the
agent is ready for a prompt, and let the agent fetch it and reply to it whether or not
agent messaging is on; the application SHALL show its state to the person as queued,
delivered or read, where read is that design's `consumed`. The inbox prints a person's
request marked as from the user of this project, with the action and the source, and not
with the envelope line that says a message is not from the user.

#### Scenario: agent messaging is off

- GIVEN agent messaging is off and the person sent a Review to a terminal agent
- WHEN that agent runs its inbox command and then its reply command for that request
- THEN it receives the request and its reply is stored as the request's answer; its inbox
  returns no agent messages and it still cannot send to other agents

#### Scenario: a reply starts no turn

- GIVEN a terminal agent replies to a person's request
- WHEN the reply is stored
- THEN no message is queued for any agent and no turn starts; the reply appears only as the
  answer notice of R16

#### Scenario: not ready

- GIVEN the target terminal agent is in the middle of a turn
- WHEN the person sends
- THEN the request shows as queued, nothing is typed into that terminal, and it becomes
  delivered when the pointer line is pasted

#### Scenario: pasted is not read

- GIVEN the pointer line was pasted and the agent has not fetched its inbox
- WHEN the person looks at the request
- THEN it shows delivered and not read

### R16. Answer notice and Bring back [Must]

WHEN the turn that a Review or a Second opinion started in a chat target ends, or a
terminal target replies to it through its command, the application SHALL show an answer
notice in the source that names the target and offers Bring back, SHALL keep it until the
person brings it back or dismisses it, and SHALL mark the source's thread unread while it
waits; Bring back drafts that request's own answer, quoted, into the source's composer and
sends nothing. For a terminal source the notice belongs to the thread that owns the
terminal.

#### Scenario: the right answer

- GIVEN the target answered the request and then answered two later messages
- WHEN the person uses Bring back on the request's notice
- THEN the draft quotes the final answer of the turn the request started, not the target's
  latest answer

#### Scenario: the person decides

- GIVEN a second opinion was answered
- WHEN the notice appears in the source
- THEN the source's agent has received nothing; after Bring back the quoted answer is in
  the composer as a draft, and it is sent only when the person sends it

#### Scenario: answered while away

- GIVEN the person closed the source panel and reloaded the application before the answer
- WHEN they open the source thread again
- THEN the notice is there and the thread was marked unread in the sidebar

#### Scenario: terminal source

- GIVEN the request was sent from an AI Terminal
- WHEN the answer arrives
- THEN the notice is on that terminal's Send to agent control and opens its composer with
  the quoted answer, to copy or to send on; nothing is typed into the terminal

#### Scenario: a turn that failed

- GIVEN the target's turn ended in an error or was interrupted
- WHEN the source is shown
- THEN the notice says the request was not answered and offers to open the target; it
  offers no Bring back

### R19. Every request has a visible state [Must]

The application SHALL keep, for every send, one request that links the source, the action,
the target, the delivered message and its answer, and SHALL show its state in a row above
the source's composer (for a terminal source, on its Send to agent control) as one of
queued, waiting, delivered, read, answered, not answered or cancelled, with a way to open
the target and, while it is queued or waiting, to cancel it. For a chat target, read means
its turn started, and delivered is not shown. A Message, Hand off or Take over row
disappears once its turn started or it was read; a Review or Second opinion row stays until
its answer notice is brought back or dismissed.

#### Scenario: the target's queue is paused

- GIVEN the target's last turn errored, so its queue is held
- WHEN the person sends a Second opinion to it
- THEN the request shows "Waiting: this agent's queue is paused" with Open and Cancel, and
  it does not stay silently queued

#### Scenario: the target is deleted

- GIVEN a request for a target that has no stored answer yet, whether queued, delivered or
  read
- WHEN the target thread is deleted, or the terminal agent it was sent to closes, exits,
  restarts or is replaced
- THEN the request shows not answered with the reason, and offers no Bring back; an answer
  stored before that moment is kept

#### Scenario: cancel

- GIVEN a queued request
- WHEN the person cancels it in the source
- THEN the target never receives it and the request shows cancelled

### R17. Out-of-tokens hint [Should]

WHILE a chat agent's last turn failed because its context window was full, or its
provider's account usage is at its limit, the application SHALL show that state beside the
agent in the control's list and put Take over from first for it.

#### Scenario: usage limit

- GIVEN the Claude account's usage is at its limit with a reset time
- WHEN the person opens the control in a Codex panel
- THEN the Claude agents read "Out of usage until <time>" and Take over from is still
  available for every other agent as well

#### Scenario: no signal

- GIVEN a Cursor agent, for which neither signal exists
- WHEN the list is shown
- THEN it carries no hint and can still be taken over from

### R18. Failed sends keep the person's work [Must]

IF a send fails or its outcome is unknown, THEN the application SHALL keep the preview with
the note and the attachments, say what failed and what to do next, and SHALL NOT deliver
the request twice when the person sends again; every send carries one request id that the
server uses to recognize a repeat.

#### Scenario: connection lost while sending

- GIVEN the connection drops after the person pressed send
- WHEN it returns and the person presses send again
- THEN the target receives the request once

#### Scenario: target gone

- GIVEN the target thread was deleted while the preview was open
- WHEN the person sends
- THEN the preview stays with its note, says the agent no longer exists, and offers to
  pick another target

## Constraints and assumptions

- The composer footer renders its actions in `ComposerFooterPrimaryActions`
  (`apps/web/src/components/chat/ChatComposer.tsx`) and already takes a menu as a slot; the
  menu, popover and permission-button components it uses carry disabled reasons in the
  label and tooltip (`apps/web/src/components/chat/ComposerPrimaryActions.tsx:56`).
- An AI Terminal has no header of its own. Its controls are three buttons in the terminal
  toolbar (`apps/web/src/components/ThreadTerminalPanel.tsx:3339-3395`), and an AI Terminal
  is one whose launch command carries activity data (`:2937`).
- A terminal selection can already be sent to the chat composer with "Add to chat"
  (`apps/web/src/components/ThreadTerminalPanel.tsx:2075-2089`, type in
  `apps/web/src/lib/terminalContext.ts`).
- The server keeps a terminal's last 5,000 lines within 1 MiB
  (`apps/server/src/terminal/manager.rs:215`, `apps/server/src/terminal/history.rs:9`). No
  RPC for a person returns a bounded tail of it; attach returns the whole history.
- A person's `thread.turn.start` may not name a source thread today: the engine accepts one
  only from an outside agent and only within one worktree
  (`apps/server/src/orchestration/engine.rs:5310-5341`). R14 needs both rules widened for a
  person's send within one project.
- The attribution chip always reads as an agent
  (`apps/web/src/components/chat/AgentActorChip.tsx`); a person's send needs its own form.
- Bring back takes the last finished answer, quotes it and appends it to the host
  composer's draft without sending (`apps/web/src/sideChatBringBack.ts`). It applies no
  size cut.
- The review launcher already takes a one-off reviewer and builds the prompt from scope
  and instructions. Its guards differ per provider: chat reviewers open in
  `approval-required`, Claude also in plan mode, and some providers cannot be kept from
  editing (`apps/web/src/codeReview.ts:49-59`, `handleStartCodeReview` in
  `apps/web/src/components/ChatView.tsx`). Terminal reviewers exist for Claude and Codex
  only.
- Outside agents reach the same command dispatcher a person's client does
  (`apps/server/src/mcp/control.rs:1387`), and the actor stamp identifies a caller without
  refusing it (`apps/server/src/production/orchestration_rpc.rs:165`). The person-send
  operation therefore has to refuse agent principals itself (R13).
- A held queue can keep a request from ever starting
  (`apps/server/src/production/turn_delivery_queue_tests.rs:319`), which is why R19 shows it.
- Claude hook validation checks only that a conversation path is absolute and ends in
  `.jsonl` (`apps/server/src/provider_terminal/claude.rs:2107`); R12 adds the ownership and
  location checks.
- A message queued for a thread waits behind a pending approval or question and is not its
  answer; answering is a separate command
  (`docs/architecture/rpc-and-orchestration.md:3512-3518`, `:4093`).
- The review launcher already has the per-provider guard wording
  (`codeReviewGuardLine`, `apps/web/src/codeReview.ts`).
- This design amends the messaging design for requests from a person only (see D15):
  - its R2: the 16,000-character limit does not apply to a person's request, whose note
    and attachments together are limited to 48,000 characters (agent's call: room for the
    largest attachment set of this design, a 4,000-character first message and a
    24,000-character tail, or two 16,000-character texts, plus the note);
  - its R5: inbox and reply work for a person's request while agent messaging is off;
  - its R6: a person's request reaches a terminal agent whatever any thread's mode is;
  - its R8: a person's request is printed as from the user, not in the agent envelope;
  - its R10: a reply to a person's request is stored as an answer and queued for nobody;
  - its R14: fetching a person's request sets that terminal's hop number back to 1, as a
    person typing into it does;
  - its D12 inbox row: the inbox also returns a person's requests, which skip R5 and R6.
- The existing context handoff takes the last 40 messages within 24,000 characters and is
  reachable only from the resume path
  (`apps/server/src/production/provider_runtime.rs:8112-8240`). Side-chat seeding reuses the
  same lines. R9 and R10 need it on demand for any thread of the project, with the first
  message added.
- A full context window is classified for Claude and Codex chat threads
  (`apps/server/src/provider/claude/failure.rs:111-200`,
  `apps/server/src/provider/codex/runtime.rs:3946`). Usage and rate limits are not a
  distinct failure class; account usage with a reset time exists for Claude and Codex only
  (`packages/contracts/src/providerUsage.ts`). AI Terminals report only that the agent
  stopped with a failure.
- Claude hooks give the path of the CLI's transcript, and the Codex observer already calls
  the methods that list a thread's turns (`apps/server/src/provider_terminal/claude.rs:2104-2160`,
  `apps/server/src/provider_terminal/codex.rs:2440-2470`). Whether Codex returns message
  text there is not verified. `docs/architecture/activity-observation.md:544` bars
  transcript reads as correlation input; R12 is a different use and that document must say
  so.
- The numbers 16,000 and 4,000 characters (agent's call: 16,000 is what `read_thread`
  returns uncut and one `terminal_read` page; 4,000 keeps a long first message from taking
  the handoff). 40 messages and 24,000 characters are copied from the existing handoff.
- Interface copy follows `UI.md`: verb labels, reasons on disabled entries, no confirmation
  for a harmless send, no em dashes.

## Decisions

D1. One Send to agent control in the chat composer footer and the AI Terminal toolbar.
Alternatives: a typed slash command (no terminal equivalent, hard to discover); actions on
sidebar agent rows (the source becomes implicit). Decided by: user (brief).

D2. A send to a chat agent is the person's own message on the existing turn queue, with a
recorded source and action. Alternative: the messaging design's agent message with a
person flag (would drag the envelope, hop and mode rules along and then switch them off).
Decided by: agent's call (brief).

D3. A send to a terminal agent uses the messaging design's store, inbox and pointer line
with the person as sender. Alternative: typing into the terminal (unverifiable, and a long
attachment cannot be pasted safely). Decided by: agent's call (brief).

D4. The preview is the only step between choosing and sending; there is no confirmation
dialog. Reason: `UI.md` reserves confirmation for destructive or expensive actions.
Decided by: agent's call.

D5. Review reuses the Code review button's prompt and launcher and attaches no diff; the
reviewer reads the checkout. Alternative: attach the diff (up to about 4 MB, and a target in
another checkout still could not open the files). Decided by: user (other checkout
refused), agent's call (no diff).

D6. A running agent that can edit may be asked for a review, with a warning in the preview.
Alternative: offer Review only to new panels and supervised agents. Decided by: user.

D7. Handoff text is the first message plus the tail, built by one server-side builder that
the resume path, side-chat seeding, Hand off and Take over all use. Alternative: the tail
alone (loses the task on long threads); a model-written summary (impossible for an agent
that ran out). Decided by: user (first message, built by BiBCode), agent's call (one
builder).

D8. Hand off and Take over move context only; no agent is stopped or archived. Decided by:
agent's call (brief).

D9. Take over from is offered for any agent; the out-of-tokens state is a hint taken from a
full context window on that thread or the provider's account usage. Alternative: offer it
only for detected agents (no signal exists for most providers and terminals). Decided by:
user.

D10. The answer notice is stored with the source thread, survives reload and a closed
panel, and marks the thread unread. Alternative: a notice that lives only while the panel
is open. Decided by: user.

D11. An answer reaches the source's agent only through Bring back. Alternative: deliver it
as an agent message that starts a turn. Decided by: user (brief).

D12. From a terminal, attachments come from the selection or the recent output first, and
from the CLI's own conversation where it can be read. Decided by: user.

D13. A terminal agent that cannot be notified is listed, disabled as a target, and usable
as a source. Decided by: agent's call (brief).

D14. The new-panel target is not offered for Take over from, because the handoff goes to
the source's own agent. Decided by: agent's call.

D15. A person's send is its own server operation, open only to a signed-in person, which
checks project and environment for every thread and terminal it touches. The existing rule
for a source named by an agent is not widened. A person's request to a terminal agent can
be fetched and answered while agent messaging is off, and its reply is stored as an answer
and queued for nobody; this amends the messaging design's R5 and R10 for person requests
only. Alternative: widen the engine's source rule for everyone (would let agents onto a
path that skips the messaging safeguards). Decided by: agent's call.

D16. One request record per send carries the correlation and the state the person sees.
A chat target's answer is the final answer of the turn the request's message started, or,
when that turn ended with a proposed plan instead of an assistant message (a Claude reviewer
in plan mode), the text of that plan (amended 2026-11-13, decided by the user); a terminal
target's answer is its reply to that request. This replaces the brief's call that
a send to a chat agent needs no store of its own: the message still travels on the turn
queue, but the request record is new stored state. Decided by: agent's call.

D17. In the menu the action is picked first, then the agent, and the answer notice is a bar
above the composer. Decided by: agent's call (shown to the user as mock-ups).

## Milestone plan

Slices, each working end to end. Slices 1 to 4 need nothing from the messaging design.

1. **Chat to chat, Message.** The control, the menu, the preview, the person-send
   operation, delivery, attribution, request state, failed sends. R1 to R6, R13, R14, R18,
   R19.
2. **Review and Second opinion, with the answer notice for chat targets.** R7, R8, R16.
3. **Hand off and Take over from between chat agents, with the hint.** R9, R10, R17.
4. **An AI Terminal as the source**, to chat targets. R11 and the terminal-source notice of
   R16.
5. **A terminal agent as the target**, including taking over into a terminal and a
   terminal's reply as the answer. R15 and the terminal halves of R10 and R16. Needs the
   messaging design's terminal identity, inbox and pointer delivery (its slice 4).
6. **Reading a CLI's conversation**, Claude first, then Codex. R12.
7. **Documentation.** `docs/user/workspace-ui.md`, `docs/architecture/rpc-and-orchestration.md`,
   `docs/architecture/providers.md`, `docs/architecture/activity-observation.md`, and the
   testing runbooks for the packaged flows.

## Risks

- A target agent treats a review request as permission to edit → the request says not to,
  new panels are read-only, and the preview warns for agents that can edit (R7). The risk
  stays for running agents; the person chose it (D6).
- Terminal output attached as context contains secrets shown on screen → the preview shows
  the exact text and lets the person cut it (R5); nothing is attached without the preview.
- The first message is not the task (the thread drifted) → the preview shows the handoff
  text, and the person can cut it and write the task in the note.
- Notices pile up for requests nobody reads → one notice per request, each dismissable,
  and a failed request says so instead of waiting forever (R16).
- Two ways to start a review confuse → the new-panel review opens exactly what the button
  opens; the button stays the one-click path for the default reviewer.

## Verification

| Requirement   | Checked by                                                                                                                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 to R6      | Web component tests of the control, the list, disabled reasons, focus and keyboard path, preview and draft keeping.                                                                                                                                             |
| R7, R8        | Web logic tests of the request text; one test that a new-panel review calls the review launcher with the picked provider.                                                                                                                                       |
| R9, R10       | Server tests of the handoff builder: first message plus tail, limits, gap marker, and that the picked thread gets no command.                                                                                                                                   |
| R11, R12      | Terminal panel tests for selection and recent output; server tests for the bounded output read; per-CLI tests with recorded, anonymized session data.                                                                                                           |
| R19           | Server tests of the request record through queued, waiting, read, answered, not answered and cancelled; web tests of the state row and Cancel.                                                                                                                  |
| R13, R14, R18 | Refusal tests for a hosted agent's credential, a terminal credential and an MCP session on the person-send operation. Orchestration tests: person send with source and action, same project across worktrees accepted, other project refused, idempotent retry. |
| R15           | The messaging design's terminal tests, with a person as sender.                                                                                                                                                                                                 |
| R16, R17      | Web tests of the notice across reload; server test that the notice is stored with the thread; hint tests with a context-limit failure and a usage snapshot.                                                                                                     |
| Goal 1        | One WebDriver end-to-end run: second opinion from a Claude panel to a Codex panel and Bring back, Profiler on.                                                                                                                                                  |

Input classes no scenario names, and what happens: a note with only whitespace counts as
empty; a target that becomes busy between preview and send is queued as in R13; an
attachment the person cut to nothing is sent as the note alone; a source thread deleted
while a notice waits drops the notice with it.

Reviews owed by the implementation: `UI.md` and `vercel-react-best-practices` for every
changed component. Profiler coverage: the new RPC methods register through the session
wrappers, none waits on a provider, and no event carries note or attachment text.

## Open questions

- Whether the Codex observer's turn listing returns message text. Owner: engineering. Can
  wait because R12 is a Should with a specified fallback.
- Whether the Code review button later becomes an entry of this menu. Owner: maintainer.
  Can wait because both work side by side.

## Appendix: interview record

- 2026-11-13 Source: approved brief / Decision: its user decisions are settled (D1, D5
  other checkout, D7 built by BiBCode, D11, D12, list of running agents and new panel) and
  its agent's calls are carried as D2, D3, D8, D13 and R6, R14, R16 terminal notice.
- 2026-11-13 Evidence: lookup of composer, terminal toolbar, review launcher, handoff
  builder, Bring back, engine source rule, failure classes and terminal observers /
  Decision: resolved without asking: no diff is attached to a review; the terminal control
  goes in the toolbar; a person's source needs an engine change; one handoff builder.
- 2026-11-13 Q: may a running agent that can edit be asked for a review / Recommended: yes,
  with a warning / Decision: as recommended (D6).
- 2026-11-13 Q: does the takeover handoff always include the first message / Recommended:
  yes / Decision: as recommended (D7).
- 2026-11-13 Q: does the out-of-tokens hint use both a full context window and account
  usage / Recommended: yes / Decision: as recommended (D9).
- 2026-11-13 Q: does the answer notice persist with the thread and mark it unread /
  Recommended: yes / Decision: as recommended (D10).
- 2026-11-13 Agent's calls, to be confirmed at approval: D2, D3, D4, D8, D13 to D17; no
  diff in a review; one handoff builder; the numbers 16,000 and 4,000; the disabled-entry
  wording of R3; a failed turn's notice offers no Bring back; a review can be asked of a
  running terminal agent with the same warning; slice order.
- 2026-11-13 Evidence: independent read (9 findings) and Codex review (5 findings) of the
  first draft / Decision: all applied: person-only operation, request record and states,
  answer bound to its request, terminal replies stored as answers, conversation-file
  checks, accurate review guards, review scope, takeover into a terminal, slice 5 scope.
- 2026-11-13 Evidence: mock-ups of the five surfaces shown to the user / Decision: recorded
  as D17, open to change at approval.
- 2026-11-13 Approval: the maintainer approved the written file, with every agent's call
  above and the amendments to the messaging design.
- 2026-11-13 Q (from the plan review): what counts as the answer when a Claude reviewer in
  plan mode ends its turn with a plan card / Recommended: the plan's text counts / Decision:
  as recommended; D16 amended, approved in chat by the maintainer.
