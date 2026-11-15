# Design brief: Send to agent

Status: Approved 2026-11-13 (approved in chat by the user)

Extends the approved [agent messaging design](./2026-11-13-agent-messaging-design.md), which
covers messages that agents send to each other. This brief covers what a person sends.

## Intent

The person running several agents in one project wants to act on another agent from the
panel or terminal they are in, without copying text between them. Four jobs:

- ask a specific agent for a code review of the work here;
- ask a specific agent for a second opinion on the last answer or plan here;
- hand the work here off to a specific agent, so it carries on there;
- take over here from an agent that ran out of tokens, so the work carries on in this panel.

Plus a plain message to a specific agent. In the approved design a person can only tell
their own agent to send something, and that agent chooses the recipient and the wording.

## Goals, non-goals and anti-goals

Goals:

- From a chat panel or an AI Terminal, the person picks an action and an agent and sends in
  one step; the context the job needs is attached for them.
- The person sees and can trim what is attached before it is sent.
- A review or a second opinion comes back to the panel it was asked from as a notice the
  person can pull into their composer.
- Taking over works when the other agent can no longer answer at all.
- The same control and the same four actions exist in chat panels and AI Terminals.

Non-goals:

- Changing how agents message each other; the approved design stands.
- Typing a request or its context into a terminal's input.
- Sending across projects or environments.
- Replacing the Source Control panel's Code review button.
- An `@agent` shortcut typed in the composer; it can be added later on the same menu.

Anti-goals:

- Context from the wrong thread is sent because the source was ambiguous.
- A request to a terminal agent is shown as read when it was only pasted.
- An answer is pushed into the person's current agent, spending its tokens, without the
  person choosing to send it.

## Constraints

- A chat thread's messages are stored, so context can be built from them. BiBCode already
  builds a context handoff from the stored transcript when a provider session cannot be
  resumed (`docs/architecture/providers.md`, "Resume failures and context handoff").
- An AI Terminal has no stored message history. BiBCode tracks the CLI's session and
  activity (Claude through hooks, Codex through its app-server connection) and keeps the
  terminal's recent output in memory. Cursor and Grok terminals have no such channel.
- Whatever is typed into a terminal goes to the CLI, so the terminal has no BiBCode composer.
- A terminal agent receives through the inbox and pointer line of the approved design, and
  only when it is ready for a prompt. Reading is proven only when the agent fetches.
- Side chats already have Bring back, which drafts the other chat's last answer into the
  composer without sending it (`docs/user/workspace-ui.md`).
- The Source Control panel already has a Code review button that opens a new side chat with
  the Code review agent chosen in Settings (`docs/plans/2026-11-11-code-review-button-design.md`).
- An agent in another worktree cannot see this checkout's changes.
- User-facing work is reviewed against `UI.md`, and React changes against the
  `vercel-react-best-practices` skill (`AGENTS.md`).

## Approaches considered

1. **A Send to agent button** beside Send in the chat composer and in the AI Terminal's
   panel header, opening a menu: action, then agent. Picked. The source is always the panel
   that was clicked in, the four actions are visible, and it is the only shape that treats
   terminals like panels. Cost: one more control on both surfaces.
2. **Typed in the composer** as a slash command with an `@agent` mention. Fast and reuses
   the command menu, but a terminal has no composer, so terminals would need a second
   control anyway, and it is hard to discover.
3. **Actions on the sidebar's agent rows.** No change to composer or terminal, but the
   source panel is implicit, which is exactly what a review or a handoff depends on.

For a terminal's missing conversation, three ways were weighed: attach the person's text
selection or the recent terminal output; read the CLI's own session through the channel
BiBCode already has; or leave Second opinion and Hand off out for terminals. Picked: the
first in the first version, with the second added per CLI after it.

## Tradeoffs accepted

- One more button on every chat composer and terminal header, in exchange for the same
  visible control everywhere.
- Context taken from a terminal is raw terminal text, limited to what is still in the
  buffer, in exchange for all four actions working for every CLI from the first version.
- An answer does not reach the current agent until the person sends it, in exchange for the
  person reading it first and no tokens spent unasked.
- A code review cannot be asked of an agent in another worktree, in exchange for never
  pasting a large diff into an agent that cannot see the files.
- Red flag, two routes to one result: Review to a new panel does what the Code review
  button does. Both stay; the new panel path must start the review the same way the button
  does, so there is one launcher and not two.
- Red flag, one decision in many places: the handoff text is needed by the existing
  resume-failure path and by Hand off and Take over. There must be one builder for it.

## Decisions

### Decided by the user

- The person sends from the current panel or terminal to a specific agent they pick.
- The jobs are code review, second opinion, handoff, and taking over from an agent that ran
  out of tokens.
- The control is a Send to agent button (approach 1).
- The agent list offers agents that are already running and a new panel with a chosen
  provider.
- A review or a second opinion comes back as a notice with Bring back, not straight into
  the current panel's agent.
- A takeover handoff is built by BiBCode from what is stored, without asking the agent that
  ran out.
- A code review to an agent in a different worktree is refused, with the reason shown.
- For terminals, the first version attaches the selection or the recent output; reading the
  CLI's own session follows per CLI.

### Agent's calls

- What the person sends is their own message, with their authority: no agent envelope, no
  hop limit and no runtime-mode ceiling. Reason: those protect against agents, and here a
  person chose the recipient and the text.
- It is marked in the recipient's transcript as sent by the person from the named panel.
  Reason: the recipient thread's history must show where a request came from.
- It works while agent-to-agent messaging is off. Reason: that setting governs what agents
  may do on their own.
- A plain Message action sits beside the four jobs and attaches nothing.
- The menu has a fifth entry for the reverse direction, Take over from, listing the other
  agents. Reason: the person is in the panel that will continue, not in the one that ran out.
- Attached context per action: review, the changes of this checkout against its base;
  second opinion, the last message of the person and the agent's last answer; hand off and
  take over, the built handoff. The person's note goes on top.
- A preview shows what is attached and its size, and lets the person remove or shorten it.
- From a terminal, the control opens a small composer over the terminal; nothing is typed
  into the CLI.
- A request to a terminal agent is stored and announced by the pointer line, and shows
  queued, delivered or read. An answer returns with Bring back only when the terminal agent
  replies through its command; otherwise the person reads it in the terminal.
- Taking over from a terminal agent uses that terminal's recent output until its CLI's
  session can be read.
- The agent list holds every chat thread of the project that has a provider session and is
  not archived or deleted, and every live AI Terminal, whether busy or idle.
- Take over from is offered for any agent, not only one detected as out of tokens. Reason:
  it is then a plain "bring that thread's context here", which needs no per-provider
  detection; an out-of-tokens state is shown as a hint when BiBCode knows it.
- Hand off and Take over move context only. The source agent is left as it is, neither
  stopped nor archived. Reason: stopping someone's agent as a side effect is a surprise.
- To a chat agent, a send is an ordinary message from the person in that thread's existing
  queue, with the source panel recorded: it starts a turn when the agent is idle and waits
  behind a running turn or a pending approval like any typed message. No separate store.
- To a terminal agent, a send uses the approved design's message record with the person as
  the sender, so hop and mode checks are skipped for it.
- A terminal agent that cannot be told it has mail (Cursor, Grok, or any CLI whose readiness
  cannot be observed) is listed but cannot be picked as a recipient, with the reason shown.
  It can still be the source of a send.
- For a request sent from a terminal, the notice appears on that terminal's Send to agent
  button and opens the small composer with the answer, to copy or to send on.
- Review to a new panel uses the provider the person picked, through the same launcher as
  the Code review button; the button keeps using the agent chosen in Settings.
- The brief lives in `docs/plans/`, the repository's place for dated designs.

## Open questions

- How much of a conversation the existing Claude and Codex terminal channels can return.
  Owner: engineering. Can wait because the first version does not depend on it.
- Whether the Code review button should later become an entry of this menu. Owner:
  maintainer. Can wait because both work side by side.

## Left to the spec

- The exact menu, labels, disabled states and their reasons, empty and error states.
- The size limits of attached context and what happens above them.
- Which out-of-tokens states BiBCode can detect per provider, and how the hint is shown.
- What the notice looks like, how long it stays, and what happens to it when the asking
  panel is closed.
- The order of work relative to the approved design's slices, since terminal delivery here
  depends on its inbox, pointer and terminal identity.
- Requirements and scenarios for every action from both surfaces to both kinds of agent.
