import {
  EnvironmentId,
  type PreviewAutomationHost,
  PreviewAutomationOperation,
  type PreviewAutomationRequest,
  type PreviewAutomationResponse,
  PreviewTabId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@bibcode/contracts";
import * as Schema from "effect/Schema";

export interface PreviewAutomationOperationContext {
  readonly requestId: PreviewAutomationRequest["requestId"];
  readonly operation: PreviewAutomationRequest["operation"];
  readonly environmentId: PreviewAutomationHost["environmentId"];
  readonly threadId: PreviewAutomationRequest["threadId"];
  readonly tabId: Exclude<PreviewAutomationRequest["tabId"], undefined> | null;
}

export class PreviewAutomationOverlayTimeoutError extends Schema.TaggedError<PreviewAutomationOverlayTimeoutError>()(
  "PreviewAutomationOverlayTimeoutError",
  {
    requestId: TrimmedNonEmptyString,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    timeoutMs: Schema.Int,
  },
) {
  get responseTag() {
    return "PreviewAutomationTimeoutError" as const;
  }

  override get message(): string {
    return `Preview webview for request ${this.requestId} on environment ${this.environmentId} thread ${this.threadId} did not register within ${this.timeoutMs}ms.`;
  }
}

export class PreviewAutomationNavigationTimeoutError extends Schema.TaggedError<PreviewAutomationNavigationTimeoutError>()(
  "PreviewAutomationNavigationTimeoutError",
  {
    requestId: TrimmedNonEmptyString,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: PreviewTabId,
    readiness: Schema.Literals(["domContentLoaded", "load"]),
    timeoutMs: Schema.Int,
  },
) {
  get responseTag() {
    return "PreviewAutomationTimeoutError" as const;
  }

  override get message(): string {
    return `Preview navigation for request ${this.requestId} on environment ${this.environmentId} thread ${this.threadId} tab ${this.tabId} did not reach ${this.readiness} readiness within ${this.timeoutMs}ms.`;
  }
}

export class PreviewAutomationViewportTimeoutError extends Schema.TaggedError<PreviewAutomationViewportTimeoutError>()(
  "PreviewAutomationViewportTimeoutError",
  {
    requestId: TrimmedNonEmptyString,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: PreviewTabId,
    timeoutMs: Schema.Int,
  },
) {
  get responseTag() {
    return "PreviewAutomationTimeoutError" as const;
  }

  override get message(): string {
    return `Preview viewport for request ${this.requestId} on environment ${this.environmentId} thread ${this.threadId} tab ${this.tabId} was not rendered within ${this.timeoutMs}ms.`;
  }
}

export class PreviewAutomationTargetUnavailableError extends Schema.TaggedError<PreviewAutomationTargetUnavailableError>()(
  "PreviewAutomationTargetUnavailableError",
  {
    requestId: TrimmedNonEmptyString,
    operation: PreviewAutomationOperation,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: Schema.NullOr(PreviewTabId),
    bridgeAvailable: Schema.Boolean,
  },
) {
  get responseTag() {
    return "PreviewAutomationTabNotFoundError" as const;
  }

  override get message(): string {
    return `Preview automation target for ${this.operation} request ${this.requestId} is unavailable on environment ${this.environmentId} thread ${this.threadId} (tab ${this.tabId ?? "unassigned"}, bridge ${this.bridgeAvailable ? "available" : "unavailable"}).`;
  }
}

export class PreviewAutomationRecordingNotActiveError extends Schema.TaggedError<PreviewAutomationRecordingNotActiveError>()(
  "PreviewAutomationRecordingNotActiveError",
  {
    requestId: TrimmedNonEmptyString,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: Schema.NullOr(PreviewTabId),
  },
) {
  get responseTag() {
    return "PreviewAutomationExecutionError" as const;
  }

  override get message(): string {
    return `Preview automation request ${this.requestId} found no active recording for tab ${this.tabId ?? "unassigned"} on environment ${this.environmentId} thread ${this.threadId}.`;
  }
}

export class PreviewAutomationTargetNotEditableHostError extends Schema.TaggedError<PreviewAutomationTargetNotEditableHostError>()(
  "PreviewAutomationTargetNotEditableHostError",
  {
    requestId: TrimmedNonEmptyString,
    operation: PreviewAutomationOperation,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: Schema.NullOr(PreviewTabId),
    selectorKind: Schema.optional(Schema.Literals(["focused-element", "locator", "selector"])),
    selectorLength: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  },
) {
  get responseTag() {
    return "PreviewAutomationTargetNotEditableError" as const;
  }

  override get message(): string {
    return `Preview automation ${this.operation} request ${this.requestId} requires an editable target in tab ${this.tabId ?? "unassigned"}.`;
  }
}

/**
 * The tab's page can't load: the gateway refused it, or this client can't
 * reach it. The automation status shape has no failure field, so the reason
 * travels in this error's message.
 */
export class PreviewAutomationPageUnreachableError extends Schema.TaggedError<PreviewAutomationPageUnreachableError>()(
  "PreviewAutomationPageUnreachableError",
  {
    requestId: TrimmedNonEmptyString,
    operation: PreviewAutomationOperation,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: Schema.NullOr(PreviewTabId),
    reason: Schema.String,
  },
) {
  get responseTag() {
    return "PreviewAutomationExecutionError" as const;
  }

  override get message(): string {
    return `Preview tab ${this.tabId ?? "unassigned"} couldn't load its page: ${this.reason}`;
  }
}

/**
 * The agent's arguments do not match the operation's contract (for example a
 * click with no target). The reason names fields and rules, never values, and
 * travels in the message so the agent can correct the call.
 */
export class PreviewAutomationInvalidInputError extends Schema.TaggedError<PreviewAutomationInvalidInputError>()(
  "PreviewAutomationInvalidInputError",
  {
    requestId: TrimmedNonEmptyString,
    operation: PreviewAutomationOperation,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: Schema.NullOr(PreviewTabId),
    reason: Schema.String,
  },
) {
  get responseTag() {
    return "PreviewAutomationInvalidInputError" as const;
  }

  override get message(): string {
    return `Invalid arguments for preview ${this.operation}: ${this.reason}`;
  }
}

const trimString = (object: Record<string, unknown>, key: string): Record<string, unknown> => {
  const value = object[key];
  if (typeof value === "string") object[key] = value.trim();
  return object;
};

/**
 * Decodes an agent's arguments with the operation's contract instead of
 * casting them; the decoded value drops unknown fields and trims locators.
 */
export function decodePreviewAutomationInput<S extends Schema.Decoder<unknown>>(
  schema: S,
  environmentId: EnvironmentId,
  request: PreviewAutomationRequest,
): S["Type"] {
  try {
    const { input } = request;
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return Schema.decodeUnknownSync(schema)(input);
    }
    // The server moves an explicit `tabId` out of the arguments; put it back so the contract's
    // tab rules (open: tabId with reuseExistingTab false) see the whole call. A default tab
    // the server assigned is not the agent's argument.
    const candidate: Record<string, unknown> = { ...input };
    if (request.tabIdExplicit && request.tabId !== undefined) candidate.tabId = request.tabId;
    // Addresses were always trimmed before use; keep accepting padded ones.
    trimString(candidate, "url");
    const { target } = candidate;
    if (typeof target === "object" && target !== null && !Array.isArray(target)) {
      candidate.target = trimString({ ...target }, "url");
    }
    const decoded = Schema.decodeUnknownSync(schema)(candidate);
    // The tab travels as `request.tabId`, as before; the bridge is not given it twice.
    if (typeof decoded === "object" && decoded !== null && "tabId" in decoded) {
      const { tabId: _tabId, ...rest } = decoded;
      return rest;
    }
    return decoded;
  } catch (cause) {
    throw new PreviewAutomationInvalidInputError({
      requestId: request.requestId,
      operation: request.operation,
      environmentId,
      threadId: request.threadId,
      tabId: request.tabId ?? null,
      reason: (cause instanceof Error ? cause.message : String(cause)).slice(0, 500),
    });
  }
}

const targetNotEditableDiagnostics = (
  cause: unknown,
): {
  readonly selectorKind?: "focused-element" | "locator" | "selector";
  readonly selectorLength?: number;
} | null => {
  if (
    typeof cause !== "object" ||
    cause === null ||
    !("_tag" in cause) ||
    cause._tag !== "PreviewAutomationTargetNotEditableError"
  ) {
    return null;
  }
  const selectorKind =
    "selectorKind" in cause &&
    (cause.selectorKind === "focused-element" ||
      cause.selectorKind === "locator" ||
      cause.selectorKind === "selector")
      ? cause.selectorKind
      : undefined;
  const selectorLength =
    "selectorLength" in cause &&
    typeof cause.selectorLength === "number" &&
    Number.isInteger(cause.selectorLength) &&
    cause.selectorLength >= 0
      ? cause.selectorLength
      : undefined;
  return {
    ...(selectorKind === undefined ? {} : { selectorKind }),
    ...(selectorLength === undefined ? {} : { selectorLength }),
  };
};

export class PreviewAutomationOperationError extends Schema.TaggedError<PreviewAutomationOperationError>()(
  "PreviewAutomationOperationError",
  {
    requestId: TrimmedNonEmptyString,
    operation: PreviewAutomationOperation,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    tabId: Schema.NullOr(PreviewTabId),
    cause: Schema.Defect(),
  },
) {
  static fromCause(
    input: PreviewAutomationOperationContext & { readonly cause: unknown },
  ): PreviewAutomationHostError {
    if (isPreviewAutomationHostError(input.cause)) return input.cause;
    const diagnostics = targetNotEditableDiagnostics(input.cause);
    return diagnostics
      ? new PreviewAutomationTargetNotEditableHostError({
          requestId: input.requestId,
          operation: input.operation,
          environmentId: input.environmentId,
          threadId: input.threadId,
          tabId: input.tabId,
          ...diagnostics,
        })
      : new PreviewAutomationOperationError(input);
  }

  get responseTag() {
    return "PreviewAutomationExecutionError" as const;
  }

  override get message(): string {
    return `Preview automation ${this.operation} request ${this.requestId} failed on environment ${this.environmentId} thread ${this.threadId} (tab ${this.tabId ?? "unassigned"}).`;
  }
}

export const PreviewAutomationHostError = Schema.Union([
  PreviewAutomationOverlayTimeoutError,
  PreviewAutomationNavigationTimeoutError,
  PreviewAutomationViewportTimeoutError,
  PreviewAutomationTargetUnavailableError,
  PreviewAutomationRecordingNotActiveError,
  PreviewAutomationTargetNotEditableHostError,
  PreviewAutomationPageUnreachableError,
  PreviewAutomationInvalidInputError,
  PreviewAutomationOperationError,
]);
export type PreviewAutomationHostError = typeof PreviewAutomationHostError.Type;

export const isPreviewAutomationHostError = Schema.is(PreviewAutomationHostError);

export function serializePreviewAutomationHostError(
  error: PreviewAutomationHostError,
): NonNullable<PreviewAutomationResponse["error"]> {
  const detail = Object.fromEntries(
    Object.entries(error).filter(
      ([key]) =>
        key !== "_tag" && key !== "cause" && key !== "name" && key !== "message" && key !== "stack",
    ),
  );
  return {
    _tag: error.responseTag,
    message: error.message,
    ...(Object.keys(detail).length === 0 ? {} : { detail }),
  };
}
