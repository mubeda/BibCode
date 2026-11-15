import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { AgentAddress } from "./sendRequests.ts";

/**
 * Messages between the agents of one project (spec Part A). An agent calls the provider tools
 * `agents_list`, `agent_message_send`, `agent_message_reply`, `agent_message_status` and
 * `agent_message_cancel`; the server takes the sender from the agent's credential, never from
 * these arguments. Off unless the `agentMessaging.enabled` setting is on.
 */

/** The longest message text, counted by the server in Unicode scalar values. */
export const AGENT_MESSAGE_MAX_CHARACTERS = 16_000;

export const AgentMessageStatus = Schema.Literals([
  "accepted",
  "queued",
  "held",
  "delivered",
  "consumed",
  "completed",
  "cancelled",
  "failed",
]);
export type AgentMessageStatus = typeof AgentMessageStatus.Type;

export const AgentMessageReason = Schema.Literals([
  "messaging_off",
  "recipient_mode_above_sender",
  "recipient_gone",
  "recipient_turn_failed",
  "recipient_queue_held",
  "delivery_failed",
  "delivery_uncertain",
]);
export type AgentMessageReason = typeof AgentMessageReason.Type;

export const AgentMessagingErrorTag = Schema.Literals([
  "AgentMessagingDisabledError",
  "AgentMessagingUnknownRecipientError",
  "AgentMessagingInvalidArgumentError",
  "AgentMessagingModeCeilingError",
  "AgentMessagingHopLimitError",
  "AgentMessagingRateLimitError",
  "AgentMessagingBacklogLimitError",
  "AgentMessagingConflictError",
  "AgentMessagingNotCancellableError",
  "AgentMessagingNoIdentityError",
  "AgentMessagingUnknownMessageError",
  "AgentMessagingRecipientGoneError",
]);
export type AgentMessagingErrorTag = typeof AgentMessagingErrorTag.Type;

export const AgentKind = Schema.Literals(["chat", "terminal"]);
export type AgentKind = typeof AgentKind.Type;

export const AgentActivityStatus = Schema.Literals([
  "working",
  "waiting",
  "blocked",
  "ready",
  "done",
  "error",
  "stopped",
  "unavailable",
]);
export type AgentActivityStatus = typeof AgentActivityStatus.Type;

/** One entry of `agents_list`: another agent of the caller's project. */
export const AgentSummary = Schema.Struct({
  address: AgentAddress,
  title: Schema.String,
  provider: Schema.String,
  kind: AgentKind,
  status: AgentActivityStatus,
  canReceive: Schema.Boolean,
});
export type AgentSummary = typeof AgentSummary.Type;

export const AgentsListResult = Schema.Struct({
  agents: Schema.Array(AgentSummary),
});
export type AgentsListResult = typeof AgentsListResult.Type;

// The server counts Unicode scalar values, so the limit counts code points, not UTF-16 units.
const AgentMessageText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter(
    (value: string) => {
      let characters = 0;
      for (const _ of value) {
        if (++characters > AGENT_MESSAGE_MAX_CHARACTERS) return false;
      }
      return true;
    },
    { expected: `a text of at most ${AGENT_MESSAGE_MAX_CHARACTERS} characters` },
  ),
);

export const AgentMessageSendInput = Schema.Struct({
  to: AgentAddress,
  text: AgentMessageText,
  clientRequestId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AgentMessageSendInput = typeof AgentMessageSendInput.Type;

export const AgentMessageReplyInput = Schema.Struct({
  inReplyTo: TrimmedNonEmptyString,
  text: AgentMessageText,
  clientRequestId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AgentMessageReplyInput = typeof AgentMessageReplyInput.Type;

export const AgentMessageReceipt = Schema.Struct({
  messageId: TrimmedNonEmptyString,
  conversationId: TrimmedNonEmptyString,
  status: AgentMessageStatus,
  hop: Schema.Number,
});
export type AgentMessageReceipt = typeof AgentMessageReceipt.Type;

export const AgentMessageStatusInput = Schema.Struct({
  messageId: TrimmedNonEmptyString,
});
export type AgentMessageStatusInput = typeof AgentMessageStatusInput.Type;

export const AgentMessageStatusResult = Schema.Struct({
  status: AgentMessageStatus,
  reason: Schema.optionalKey(AgentMessageReason),
  updatedAt: IsoDateTime,
  replyMessageId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AgentMessageStatusResult = typeof AgentMessageStatusResult.Type;

export const AgentMessageCancelInput = Schema.Struct({
  messageId: TrimmedNonEmptyString,
});
export type AgentMessageCancelInput = typeof AgentMessageCancelInput.Type;

/**
 * The actor the server stamps on an agent message: the sending agent, named by its address and
 * its thread title at send time (untrusted text, rendered as text). It never carries a person's
 * authority.
 */
export const OrchestrationHostedAgentActor = Schema.Struct({
  kind: Schema.Literal("hosted-agent"),
  address: AgentAddress,
  label: Schema.NullOr(Schema.String),
});
export type OrchestrationHostedAgentActor = typeof OrchestrationHostedAgentActor.Type;
