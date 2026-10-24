/**
 * How a user message's body splits into what the timeline renders: the Markdown parts, in
 * order, between terminal-context chips and review-comment cards. The row renders from this
 * layout and Find in thread projects the same Markdown parts, so the n-th part has the same
 * text and the same find scope on both sides.
 */
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import {
  extractTrailingElementContexts,
  type ParsedElementContextEntry,
} from "~/lib/elementContext";
import {
  extractTrailingPreviewAnnotation,
  type ParsedPreviewAnnotation,
} from "~/lib/previewAnnotation";
import {
  parseReviewCommentMessageSegments,
  type ReviewCommentContext,
} from "../../reviewCommentContext";
import {
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";

const MAX_COLLAPSED_USER_MESSAGE_LINES = 8;
const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600;

/** A long user body renders clipped behind "Show full message". */
export function shouldCollapseUserMessage(text: string): boolean {
  if (text.trim().length === 0) {
    return false;
  }

  return (
    text.length > MAX_COLLAPSED_USER_MESSAGE_LENGTH ||
    text.split("\n").length > MAX_COLLAPSED_USER_MESSAGE_LINES
  );
}

/** A sent user message's parts: the body text and the contexts shown beside it. */
export interface SentUserMessageBody {
  readonly bodyText: string;
  readonly terminalContexts: ParsedTerminalContextEntry[];
  readonly previewAnnotations: ParsedPreviewAnnotation[];
  readonly elementContexts: ParsedElementContextEntry[];
  readonly copyText: string;
}

/** Strips the contexts a sent message carries, in the order the composer appended them. */
export function deriveSentUserMessageBody(text: string): SentUserMessageBody {
  const displayed = deriveDisplayedUserMessageState(text);
  const previewAnnotations: ParsedPreviewAnnotation[] = [];
  let visibleText = displayed.visibleText;
  while (true) {
    const extracted = extractTrailingPreviewAnnotation(visibleText);
    if (!extracted.annotation) break;
    previewAnnotations.unshift(extracted.annotation);
    visibleText = extracted.promptText;
  }
  const elementContextState = extractTrailingElementContexts(visibleText);
  return {
    bodyText: elementContextState.promptText,
    terminalContexts: displayed.contexts,
    previewAnnotations,
    elementContexts: [...displayed.elementContexts, ...elementContextState.contexts],
    copyText: displayed.copyText,
  };
}

/** One Markdown part, with the whitespace the row renders around it as plain text. */
export interface UserMessageMarkdownPart {
  readonly kind: "markdown";
  readonly key: string;
  readonly text: string;
  readonly leadingWhitespace: string;
  readonly trailingWhitespace: string;
}

export type UserMessageBodyLayout =
  | {
      readonly kind: "review-comments";
      readonly parts: ReadonlyArray<
        | UserMessageMarkdownPart
        | { readonly kind: "review-comment"; readonly comment: ReviewCommentContext }
      >;
    }
  | {
      /** Terminal-context labels the text names, rendered as chips where they appear. */
      readonly kind: "inline-terminal-contexts";
      readonly parts: ReadonlyArray<
        | UserMessageMarkdownPart
        | {
            readonly kind: "terminal-context";
            readonly key: string;
            readonly context: ParsedTerminalContextEntry;
          }
      >;
    }
  | {
      /** Terminal-context chips ahead of the whole text. */
      readonly kind: "leading-terminal-contexts";
      readonly contexts: ReadonlyArray<ParsedTerminalContextEntry>;
      readonly markdown: UserMessageMarkdownPart | null;
    }
  | { readonly kind: "markdown"; readonly markdown: UserMessageMarkdownPart | null };

function wholeTextPart(key: string, text: string): UserMessageMarkdownPart | null {
  return text.length > 0
    ? { kind: "markdown", key, text, leadingWhitespace: "", trailingWhitespace: "" }
    : null;
}

function inlineSegmentPart(key: string, text: string): UserMessageMarkdownPart {
  const leadingWhitespace = /^\s+/.exec(text)?.[0] ?? "";
  const withoutLeading = text.slice(leadingWhitespace.length);
  const trailingWhitespace = /\s+$/.exec(withoutLeading)?.[0] ?? "";
  return {
    kind: "markdown",
    key,
    text: withoutLeading.slice(0, withoutLeading.length - trailingWhitespace.length),
    leadingWhitespace,
    trailingWhitespace,
  };
}

function deriveInlineTerminalParts(
  text: string,
  contexts: ReadonlyArray<ParsedTerminalContextEntry>,
): Extract<UserMessageBodyLayout, { kind: "inline-terminal-contexts" }>["parts"] | null {
  const parts: Array<
    Extract<UserMessageBodyLayout, { kind: "inline-terminal-contexts" }>["parts"][number]
  > = [];
  let cursor = 0;
  for (const context of contexts) {
    const label = formatInlineTerminalContextLabel(context.header);
    const matchIndex = text.indexOf(label, cursor);
    if (matchIndex === -1) {
      return null;
    }
    if (matchIndex > cursor) {
      parts.push(
        inlineSegmentPart(
          `user-terminal-context-inline-before:${context.header}:${cursor}`,
          text.slice(cursor, matchIndex),
        ),
      );
    }
    parts.push({
      kind: "terminal-context",
      key: `user-terminal-context-inline:${context.header}`,
      context,
    });
    cursor = matchIndex + label.length;
  }
  if (parts.length === 0) {
    return null;
  }
  if (cursor < text.length) {
    parts.push(
      inlineSegmentPart(`user-message-terminal-context-inline-rest:${cursor}`, text.slice(cursor)),
    );
  }
  return parts;
}

export function deriveUserMessageBodyLayout(
  text: string,
  terminalContexts: ReadonlyArray<ParsedTerminalContextEntry>,
): UserMessageBodyLayout {
  const reviewCommentSegments = parseReviewCommentMessageSegments(text);
  if (reviewCommentSegments.some((segment) => segment.kind === "review-comment")) {
    const parts: Array<
      Extract<UserMessageBodyLayout, { kind: "review-comments" }>["parts"][number]
    > = [];
    for (const segment of reviewCommentSegments) {
      if (segment.kind === "review-comment") {
        parts.push({ kind: "review-comment", comment: segment.comment });
        continue;
      }
      const part = wholeTextPart(segment.id, segment.text.trim());
      if (part) parts.push(part);
    }
    return { kind: "review-comments", parts };
  }

  if (terminalContexts.length > 0) {
    if (textContainsInlineTerminalContextLabels(text, terminalContexts)) {
      const parts = deriveInlineTerminalParts(text, terminalContexts);
      if (parts) {
        return { kind: "inline-terminal-contexts", parts };
      }
    }
    return {
      kind: "leading-terminal-contexts",
      contexts: terminalContexts,
      markdown: wholeTextPart("user-message-terminal-context-inline-text", text),
    };
  }

  return { kind: "markdown", markdown: wholeTextPart("user-message-text", text) };
}

/** The Markdown parts the row renders through `ChatMarkdown`, in order. */
export function userMessageMarkdownParts(
  layout: UserMessageBodyLayout,
): ReadonlyArray<UserMessageMarkdownPart> {
  switch (layout.kind) {
    case "review-comments":
    case "inline-terminal-contexts":
      return layout.parts.filter(
        (part): part is UserMessageMarkdownPart => part.kind === "markdown" && part.text.length > 0,
      );
    case "leading-terminal-contexts":
    case "markdown":
      return layout.markdown ? [layout.markdown] : [];
  }
}
