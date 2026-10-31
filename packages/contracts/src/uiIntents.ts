import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrchestrationActor } from "./orchestration.ts";

/**
 * UI intents (#139, slice X4): an outside agent's suggestion of what a person might look at.
 * Clients raise a non-modal notice and move nothing until the person clicks **Show**. The
 * server stamps `actor` from the agent's authenticated session; labels are untrusted text.
 */

/** What a `focus` intent may ask to show. */
export const UiIntentSurface = Schema.Literals(["thread", "files", "sourceControl", "diff"]);
export type UiIntentSurface = typeof UiIntentSurface.Type;

/** How long a `focus` intent stays pending, and how many one thread may hold. */
export const UI_FOCUS_INTENT_TTL_MS = 60_000;
export const UI_FOCUS_INTENTS_PER_THREAD = 16;

/** "Show this thread, or its files, Source Control or diff" (`focus_ui`). */
export const UiFocusIntent = Schema.Struct({
  kind: Schema.Literal("focus"),
  intentId: TrimmedNonEmptyString,
  threadId: ThreadId,
  surface: UiIntentSurface,
  /** For `files` and `diff`: a file relative to the thread's folder. */
  path: Schema.NullOr(Schema.String),
  actor: OrchestrationActor,
  createdAt: IsoDateTime,
  /** When clients stop offering it: 60 seconds after `createdAt`. */
  expiresAt: IsoDateTime,
});
export type UiFocusIntent = typeof UiFocusIntent.Type;

/** How long a `commitMessage` intent stays pending, and its longest message. */
export const UI_COMMIT_MESSAGE_INTENT_TTL_MS = 24 * 60 * 60 * 1000;
export const UI_COMMIT_MESSAGE_MAX_LENGTH = 8_000;

/**
 * "Here is a commit message for this folder" (`git_set_commit_message`, slice X7). The server
 * keeps the last one per `cwd` for 24 hours. A Source Control panel showing `cwd` fills an empty
 * draft with it and only offers it over a draft with text; it never commits. `message` is
 * untrusted text.
 */
export const UiCommitMessageIntent = Schema.Struct({
  kind: Schema.Literal("commitMessage"),
  intentId: TrimmedNonEmptyString,
  /**
   * Rises with every commit message the server publishes (from the clock, so it keeps rising
   * across a restart). A client keeps a folder's highest, whatever order they arrive in.
   */
  sequence: NonNegativeInt,
  threadId: ThreadId,
  /** The thread's folder, as the server resolved it. */
  cwd: TrimmedNonEmptyString,
  message: Schema.String,
  actor: OrchestrationActor,
  createdAt: IsoDateTime,
  /** When clients stop offering it: 24 hours after `createdAt`. */
  expiresAt: IsoDateTime,
});
export type UiCommitMessageIntent = typeof UiCommitMessageIntent.Type;

/** Every intent kind. */
export const UiIntent = Schema.Union([UiFocusIntent, UiCommitMessageIntent]);
export type UiIntent = typeof UiIntent.Type;

/** `subscribeUiIntents`: the intents still pending, then each new one. */
export const UiIntentStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    intents: Schema.Array(UiIntent),
  }),
  Schema.Struct({
    type: Schema.Literal("intent"),
    intent: UiIntent,
  }),
]);
export type UiIntentStreamEvent = typeof UiIntentStreamEvent.Type;

/**
 * `ui.publishIntent`: only an outside agent's MCP session may publish. Without `kind` the input
 * is a `focus` intent.
 */
export const UiPublishIntentInput = Schema.Union([
  Schema.Struct({
    kind: Schema.optional(Schema.Literal("focus")),
    threadId: ThreadId,
    surface: UiIntentSurface,
    path: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    kind: Schema.Literal("commitMessage"),
    threadId: ThreadId,
    cwd: TrimmedNonEmptyString,
    message: Schema.String.check(Schema.isMaxLength(UI_COMMIT_MESSAGE_MAX_LENGTH)),
  }),
]);
export type UiPublishIntentInput = typeof UiPublishIntentInput.Type;

export const UiPublishIntentResult = Schema.Struct({
  intentId: TrimmedNonEmptyString,
  /** How many clients were subscribed when it was published. */
  subscribers: NonNegativeInt,
});
export type UiPublishIntentResult = typeof UiPublishIntentResult.Type;

export class UiIntentError extends Schema.TaggedError<UiIntentError>()("UiIntentError", {
  /**
   * `actor` (not an outside agent), `invalid` (including an empty or over-long commit message,
   * or one with control characters other than tabs and line breaks), or `limit` (16 `focus`
   * intents pending for the thread, or 64 for the agent).
   */
  reason: Schema.Literals(["actor", "invalid", "limit"]),
  message: Schema.String,
}) {}
