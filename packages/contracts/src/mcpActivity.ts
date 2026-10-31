import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * What one mutating MCP tool call acted on, as ids and counts only (#139, slice X1): never a
 * path, message, branch name or output. Every field is optional; a call names what it touched.
 */
export const McpActivityTarget = Schema.Struct({
  /** The commit a call made. */
  sha: Schema.optional(Schema.String),
  /** The commit a revert undid. */
  revertedSha: Schema.optional(Schema.String),
  pullRequest: Schema.optional(NonNegativeInt),
  worktreeKey: Schema.optional(Schema.String),
  fileCount: Schema.optional(NonNegativeInt),
  cloneId: Schema.optional(Schema.String),
  transferId: Schema.optional(Schema.String),
});
export type McpActivityTarget = typeof McpActivityTarget.Type;

/** One row of the agent activity log. */
export const McpActivityRow = Schema.Struct({
  id: NonNegativeInt,
  occurredAt: IsoDateTime,
  /** The agent's session id: the `clientId` of its actor. */
  clientId: TrimmedNonEmptyString,
  /** Its Authorized clients label when it acted (untrusted text). */
  label: Schema.NullOr(Schema.String),
  tool: TrimmedNonEmptyString,
  threadId: Schema.NullOr(Schema.String),
  /** `success`, or the typed failure's tag. */
  outcome: TrimmedNonEmptyString,
  target: McpActivityTarget,
});
export type McpActivityRow = typeof McpActivityRow.Type;

/** An agent with a call in the last 2 minutes or work still running. */
export const McpActiveClient = Schema.Struct({
  clientId: TrimmedNonEmptyString,
  label: Schema.NullOr(Schema.String),
  lastCallAt: Schema.NullOr(IsoDateTime),
  /** A call, owned mutation or attributed turn is in flight now. */
  running: Schema.Boolean,
  /**
   * Running turns whose latest user message this agent sent. Such an agent stays active
   * however long ago it last called, revoked or not, so Stop stays in reach.
   */
  runningTurns: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
});
export type McpActiveClient = typeof McpActiveClient.Type;

/**
 * `subscribeMcpActivity`: a snapshot of the newest 200 rows (newest first) and the active
 * agents, then each new row and each change of who is active.
 */
export const McpActivityStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    rows: Schema.Array(McpActivityRow),
    active: Schema.Array(McpActiveClient),
  }),
  Schema.Struct({
    type: Schema.Literal("row"),
    row: McpActivityRow,
  }),
  Schema.Struct({
    type: Schema.Literal("active"),
    active: Schema.Array(McpActiveClient),
  }),
]);
export type McpActivityStreamEvent = typeof McpActivityStreamEvent.Type;

export class McpActivityError extends Schema.TaggedError<McpActivityError>()("McpActivityError", {
  message: Schema.String,
}) {}

/** How many rows the activity stream starts with. */
export const MCP_ACTIVITY_RECENT_ROWS = 200;
