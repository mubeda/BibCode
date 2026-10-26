import * as Schema from "effect/Schema";

import {
  CommandId,
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
 * thread was deleted is `alreadyImported` without one. `hostThreadId` is set
 * when that thread is a chat panel (a session continued from History), so
 * opening it means activating the panel in its host.
 */
export const AgentSessionCandidate = Schema.Struct({
  provider: AgentSessionProvider,
  sessionId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  messageCount: NonNegativeInt,
  lastActiveAt: IsoDateTime,
  alreadyImported: Schema.Boolean,
  threadId: Schema.optionalKey(ThreadId),
  hostThreadId: Schema.optionalKey(ThreadId),
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

/** History lists the terminal sessions of a thread's folder; the server resolves the folder. */
export const AgentSessionThreadListInput = Schema.Struct({ threadId: ThreadId });
export type AgentSessionThreadListInput = typeof AgentSessionThreadListInput.Type;

/**
 * Whether a terminal still has the session open, as far as Claude Code's
 * running-session files tell: `unknown` when they could not be read
 * completely, which History treats like `live`.
 */
export const AgentSessionLiveness = Schema.Literals(["closed", "live", "unknown"]);
export type AgentSessionLiveness = typeof AgentSessionLiveness.Type;

/**
 * The import of a session whose history committed. `resumeRefused`: Claude
 * Code refused the import's resume, so History offers a copy instead of Open.
 */
export const AgentSessionImportedThread = Schema.Struct({
  threadId: ThreadId,
  hostThreadId: Schema.NullOr(ThreadId),
  archived: Schema.Boolean,
  resumeRefused: Schema.Boolean,
});
export type AgentSessionImportedThread = typeof AgentSessionImportedThread.Type;

/**
 * A Claude Code session run in a terminal in the thread's folder in the last
 * 30 days. `importDeleted`: its import's thread was deleted, so only a copy is
 * possible.
 */
export const AgentSessionHistoryEntry = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  lastActiveAt: IsoDateTime,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  liveness: AgentSessionLiveness,
  importedThread: Schema.optionalKey(AgentSessionImportedThread),
  importDeleted: Schema.Boolean,
});
export type AgentSessionHistoryEntry = typeof AgentSessionHistoryEntry.Type;

/**
 * Newest first. `truncated` means older sessions may exist than were listed.
 * `copySupported`: the server's Claude Code honors `--session-id` with
 * `--fork-session` (2.0.73 and later), which **Continue in a copy** needs.
 */
export const AgentSessionThreadListResult = Schema.Struct({
  sessions: Schema.Array(AgentSessionHistoryEntry),
  truncated: Schema.Boolean,
  copySupported: Schema.Boolean,
});
export type AgentSessionThreadListResult = typeof AgentSessionThreadListResult.Type;

/** `resume` continues the session itself; `fork` continues a copy under a server-assigned ID. */
export const AgentSessionOpenMode = Schema.Literals(["resume", "fork"]);
export type AgentSessionOpenMode = typeof AgentSessionOpenMode.Type;

/** A retry with the same `commandId` reaches the same panel. */
export const AgentSessionOpenInPanelInput = Schema.Struct({
  commandId: CommandId,
  hostThreadId: ThreadId,
  sessionId: TrimmedNonEmptyString,
  mode: AgentSessionOpenMode,
});
export type AgentSessionOpenInPanelInput = typeof AgentSessionOpenInPanelInput.Type;

/**
 * `existing`: the session already had a thread. `hostThreadId` is the host of
 * the panel to activate, or `null` when that thread is a sidebar thread.
 */
export const AgentSessionOpenInPanelResult = Schema.Struct({
  threadId: ThreadId,
  hostThreadId: Schema.NullOr(ThreadId),
  outcome: Schema.Literals(["created", "existing"]),
});
export type AgentSessionOpenInPanelResult = typeof AgentSessionOpenInPanelResult.Type;

export class AgentSessionsError extends Schema.TaggedError<AgentSessionsError>()(
  "AgentSessionsError",
  { message: TrimmedNonEmptyString },
) {}
