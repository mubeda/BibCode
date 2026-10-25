export interface MarkdownActionFailureContext {
  readonly operation: string;
  readonly target?: string;
  readonly format?: "markdown" | "csv";
  readonly language?: string;
  readonly fenceTitle?: string;
  readonly copyTarget?: string;
  /** A failure's class, such as a diagram error code; never message or source text. */
  readonly code?: string;
}

/**
 * Logs a failed rendered-Markdown action. A diagram failure passes no cause: its error text
 * can quote the diagram source, which never reaches a log.
 */
export function reportMarkdownActionFailure(
  context: MarkdownActionFailureContext,
  cause?: unknown,
): void {
  if (cause === undefined) {
    console.error("[chat-markdown] action failed", context);
    return;
  }
  console.error("[chat-markdown] action failed", context, cause);
}
