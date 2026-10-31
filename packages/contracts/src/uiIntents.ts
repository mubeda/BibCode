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

/** Every intent kind; slice X7 adds `commitMessage`. */
export const UiIntent = Schema.Union([UiFocusIntent]);
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

/** `ui.publishIntent`: only an outside agent's MCP session may publish. */
export const UiPublishIntentInput = Schema.Struct({
  threadId: ThreadId,
  surface: UiIntentSurface,
  path: Schema.optional(Schema.NullOr(Schema.String)),
});
export type UiPublishIntentInput = typeof UiPublishIntentInput.Type;

export const UiPublishIntentResult = Schema.Struct({
  intentId: TrimmedNonEmptyString,
  /** How many clients were subscribed when it was published. */
  subscribers: NonNegativeInt,
});
export type UiPublishIntentResult = typeof UiPublishIntentResult.Type;

export class UiIntentError extends Schema.TaggedError<UiIntentError>()("UiIntentError", {
  /** `actor` (not an outside agent), `invalid`, or `limit` (16 pending for the thread). */
  reason: Schema.Literals(["actor", "invalid", "limit"]),
  message: Schema.String,
}) {}
