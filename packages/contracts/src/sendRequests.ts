import * as Schema from "effect/Schema";

import { IsoDateTime, MessageId, ThreadId, TrimmedNonEmptyString, TurnId } from "./baseSchemas.ts";

/**
 * A person's request to a specific agent (review, second opinion, hand-off, take-over or
 * message), sent from a chat panel or an AI Terminal. The server stores one record per
 * `requestId` and queues the request as that person's own message on the target. Every
 * `sendRequests.*` method refuses an agent's credential.
 *
 * Character limits are counted by the server in Unicode scalar values. These schemas pin no
 * text length, so a client and a server never disagree about UTF-16 units.
 */

/** Note plus attachment text of one request. */
export const SEND_REQUEST_MAX_CHARS = 48_000;
/** The lead-in the client writes before the note. */
export const SEND_REQUEST_LEAD_IN_MAX_CHARS = 16_000;
/** The stored answer of a request is cut at this length. */
export const SEND_REQUEST_ANSWER_MAX_CHARS = 48_000;

const AGENT_ADDRESS_PATTERN = /^(?:thread:[^\s/]+|terminal:[^\s/]+\/[^\s/]+)$/;

/** `thread:{threadId}` for a chat agent, `terminal:{threadId}/{terminalId}` for a terminal agent. */
export const AgentAddress = Schema.String.check(Schema.isPattern(AGENT_ADDRESS_PATTERN));
export type AgentAddress = typeof AgentAddress.Type;

export const SendRequestAction = Schema.Literals([
  "review",
  "second-opinion",
  "hand-off",
  "take-over",
  "message",
]);
export type SendRequestAction = typeof SendRequestAction.Type;

export const SendRequestState = Schema.Literals([
  "queued",
  "waiting",
  "delivered",
  "read",
  "answered",
  "not_answered",
  "cancelled",
]);
export type SendRequestState = typeof SendRequestState.Type;

export const SendRequestReason = Schema.Literals([
  "queue_paused",
  "delivery_failed",
  "turn_failed",
  "turn_interrupted",
  "target_deleted",
  "no_answer",
  "recipient_gone",
]);
export type SendRequestReason = typeof SendRequestReason.Type;

/** The provenance a person's send puts on its message. */
export const PersonSend = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  action: SendRequestAction,
  /** The agent the request came from; for a take-over, the agent whose work is taken over. */
  sourceAddress: AgentAddress,
});
export type PersonSend = typeof PersonSend.Type;

export const SendRequestAttachment = Schema.Struct({
  label: Schema.String,
  text: Schema.String,
});
export type SendRequestAttachment = typeof SendRequestAttachment.Type;

/** `sendRequests.send`. It carries no actor, mode or sender: the server resolves them. */
export const SendRequestsSendInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  action: SendRequestAction,
  source: AgentAddress,
  target: AgentAddress,
  /** Only for `take-over`: the agent whose work the source takes over. */
  takenOver: Schema.optional(AgentAddress),
  leadIn: Schema.String,
  note: Schema.String,
  attachments: Schema.Array(SendRequestAttachment),
});
export type SendRequestsSendInput = typeof SendRequestsSendInput.Type;

/** One stored request. It carries no answer text; `sendRequests.getAnswer` reads it. */
export const SendRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  action: SendRequestAction,
  source: AgentAddress,
  sourceThreadId: ThreadId,
  target: AgentAddress,
  targetThreadId: ThreadId,
  takenOver: Schema.NullOr(AgentAddress),
  targetMessageId: Schema.NullOr(MessageId),
  state: SendRequestState,
  reason: Schema.NullOr(SendRequestReason),
  answerMessageId: Schema.NullOr(MessageId),
  answeringTurnId: Schema.NullOr(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  dismissedAt: Schema.NullOr(IsoDateTime),
});
export type SendRequest = typeof SendRequest.Type;

export const SendRequestsCancelInput = Schema.Struct({ requestId: TrimmedNonEmptyString });
export type SendRequestsCancelInput = typeof SendRequestsCancelInput.Type;

/** `cancelled` is false when the request had already been read. */
export const SendRequestsCancelResult = Schema.Struct({
  request: SendRequest,
  cancelled: Schema.Boolean,
});
export type SendRequestsCancelResult = typeof SendRequestsCancelResult.Type;

export const SendRequestsDismissInput = Schema.Struct({ requestId: TrimmedNonEmptyString });
export type SendRequestsDismissInput = typeof SendRequestsDismissInput.Type;

/** Without `threadId`, every request of the environment. */
export const SendRequestsSubscribeInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
});
export type SendRequestsSubscribeInput = typeof SendRequestsSubscribeInput.Type;

/** A `snapshot` holds the first page; `page` events carry the rest, then changes follow. */
export const SendRequestsStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), requests: Schema.Array(SendRequest) }),
  Schema.Struct({ type: Schema.Literal("page"), requests: Schema.Array(SendRequest) }),
  Schema.Struct({ type: Schema.Literal("upsert"), request: SendRequest }),
  Schema.Struct({ type: Schema.Literal("remove"), requestId: TrimmedNonEmptyString }),
]);
export type SendRequestsStreamEvent = typeof SendRequestsStreamEvent.Type;

export const SendRequestsGetAnswerInput = Schema.Struct({ requestId: TrimmedNonEmptyString });
export type SendRequestsGetAnswerInput = typeof SendRequestsGetAnswerInput.Type;

export const SendRequestsGetAnswerResult = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  text: Schema.String,
  truncated: Schema.Boolean,
});
export type SendRequestsGetAnswerResult = typeof SendRequestsGetAnswerResult.Type;

/** `sourceThreadId` is the thread the person clicked in; `threadId` is the thread to read. */
export const SendRequestsGetHandoffTextInput = Schema.Struct({
  sourceThreadId: ThreadId,
  threadId: ThreadId,
});
export type SendRequestsGetHandoffTextInput = typeof SendRequestsGetHandoffTextInput.Type;

export const SendRequestsGetHandoffTextResult = Schema.Struct({
  threadId: ThreadId,
  text: Schema.String,
  leftOut: Schema.Number,
  includedMessages: Schema.Number,
});
export type SendRequestsGetHandoffTextResult = typeof SendRequestsGetHandoffTextResult.Type;

const TerminalOutputSource = Schema.Literals(["output", "conversation"]);

export const SendRequestsGetTerminalOutputInput = Schema.Struct({
  sourceThreadId: ThreadId,
  threadId: ThreadId,
  terminalId: TrimmedNonEmptyString,
  source: TerminalOutputSource,
  part: Schema.Literals(["last-answer", "handoff"]),
});
export type SendRequestsGetTerminalOutputInput = typeof SendRequestsGetTerminalOutputInput.Type;

export const SendRequestsGetTerminalOutputResult = Schema.Struct({
  threadId: ThreadId,
  terminalId: TrimmedNonEmptyString,
  text: Schema.String,
  truncated: Schema.Boolean,
  usedSource: TerminalOutputSource,
  fellBack: Schema.Boolean,
  startMissing: Schema.Boolean,
});
export type SendRequestsGetTerminalOutputResult = typeof SendRequestsGetTerminalOutputResult.Type;

export class SendRequestError extends Schema.TaggedError<SendRequestError>()("SendRequestError", {
  reason: Schema.Literals([
    "person_only",
    "invalid",
    "too_long",
    "other_project",
    "unknown_thread",
    "target_not_notifiable",
    "request_conflict",
    "not_found",
    "not_final",
    "not_answered",
    "not_cancellable",
    "storage",
  ]),
  message: Schema.String,
}) {}
