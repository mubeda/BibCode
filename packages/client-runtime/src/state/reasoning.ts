/**
 * The presentation of provider reasoning (#173) that every client shares: Claude thinking
 * and Codex reasoning summaries read the same way, as one collapsed row per block.
 */
import type { OrchestrationReasoning } from "@bibcode/contracts";

const REASONING_PREVIEW_MAX_CHARS = 160;
const LATEST_THOUGHT_MAX_CHARS = 200;
const ELLIPSIS = "…";

/** "Thinking" while the block streams, "Thought" once it ended. */
export function reasoningLabel(
  reasoning: Pick<OrchestrationReasoning, "streaming">,
): "Thinking" | "Thought" {
  return reasoning.streaming ? "Thinking" : "Thought";
}

/** The first non-empty line, as plain text: what the thought is about. */
export function reasoningPreview(reasoning: Pick<OrchestrationReasoning, "text">): string | null {
  const line = firstNonEmptyLine(reasoning.text);
  return line === null ? null : capped(plainMarkdownLine(line), REASONING_PREVIEW_MAX_CHARS);
}

/**
 * One line for the working row: a Codex summary's bold heading, which is how it starts, or
 * the trace's first sentence.
 */
export function latestThoughtLine(reasoning: Pick<OrchestrationReasoning, "text">): string | null {
  const line = firstNonEmptyLine(reasoning.text);
  if (line === null) {
    return null;
  }
  const heading = /^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/u.exec(line);
  if (heading?.[1] !== undefined) {
    return capped(plainMarkdownLine(heading[1]), LATEST_THOUGHT_MAX_CHARS);
  }
  const plain = plainMarkdownLine(reasoning.text.replace(/\s+/gu, " "));
  const sentence = /^.*?[.!?](?=\s|$)/u.exec(plain)?.[0] ?? plain;
  return capped(sentence, LATEST_THOUGHT_MAX_CHARS);
}

function firstNonEmptyLine(text: string): string | null {
  for (const line of text.split("\n")) {
    if (plainMarkdownLine(line).length > 0) {
      return line;
    }
  }
  return null;
}

/** Markdown markers removed and whitespace collapsed. */
function plainMarkdownLine(line: string): string {
  return line
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d{1,3}[.)]\s+)/u, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/(\*\*|__|~~|`)/gu, "")
    .replace(/(^|[\s(])[*_](\S(?:.*?\S)?)[*_](?=[\s).,!?:;]|$)/gu, "$1$2")
    .replace(/\s+/gu, " ")
    .trim();
}

function capped(text: string, maxChars: number): string {
  const characters = Array.from(text);
  if (characters.length <= maxChars) {
    return text;
  }
  return `${characters
    .slice(0, maxChars - ELLIPSIS.length)
    .join("")
    .trimEnd()}${ELLIPSIS}`;
}
