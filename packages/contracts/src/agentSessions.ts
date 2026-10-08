import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** The most sessions one scan lists and one import accepts. */
export const AGENT_SESSION_IMPORT_LIMIT = 200;

/** Coding agent CLIs whose sessions on the server host can be imported. */
export const AgentSessionProvider = Schema.Literals(["claudeAgent", "codex"]);
export type AgentSessionProvider = typeof AgentSessionProvider.Type;

export const AgentSessionScanInput = Schema.Struct({ projectId: ProjectId });
export type AgentSessionScanInput = typeof AgentSessionScanInput.Type;

/**
 * A CLI session recorded in the project's workspace root in the last 30 days.
 * `threadId` names the live thread an earlier import created; an import whose
 * thread was deleted is `alreadyImported` without one.
 */
export const AgentSessionCandidate = Schema.Struct({
  provider: AgentSessionProvider,
  sessionId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  messageCount: NonNegativeInt,
  lastActiveAt: IsoDateTime,
  alreadyImported: Schema.Boolean,
  threadId: Schema.optionalKey(ThreadId),
});
export type AgentSessionCandidate = typeof AgentSessionCandidate.Type;

/** Newest first. `truncated` means more sessions exist than were listed. */
export const AgentSessionScanResult = Schema.Struct({
  candidates: Schema.Array(AgentSessionCandidate),
  truncated: Schema.Boolean,
});
export type AgentSessionScanResult = typeof AgentSessionScanResult.Type;

export const AgentSessionRef = Schema.Struct({
  provider: AgentSessionProvider,
  sessionId: TrimmedNonEmptyString,
});
export type AgentSessionRef = typeof AgentSessionRef.Type;

export const AgentSessionImportInput = Schema.Struct({
  projectId: ProjectId,
  sessions: Schema.Array(AgentSessionRef).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(AGENT_SESSION_IMPORT_LIMIT),
  ),
});
export type AgentSessionImportInput = typeof AgentSessionImportInput.Type;

/** Each imported session's thread resumes the CLI conversation on its next turn. */
export const AgentSessionImportResult = Schema.Struct({
  imported: Schema.Array(Schema.Struct({ sessionId: TrimmedNonEmptyString, threadId: ThreadId })),
  skipped: Schema.Array(
    Schema.Struct({ sessionId: TrimmedNonEmptyString, reason: TrimmedNonEmptyString }),
  ),
});
export type AgentSessionImportResult = typeof AgentSessionImportResult.Type;

export class AgentSessionsError extends Schema.TaggedError<AgentSessionsError>()(
  "AgentSessionsError",
  { message: TrimmedNonEmptyString },
) {}
