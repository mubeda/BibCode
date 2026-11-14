/**
 * **Bring back** (#265): a side chat's last answer, quoted, goes into its host's composer as a
 * draft. It is never sent: the user reads, edits and sends it. Composed here from the side
 * chat's own messages; nothing reaches the server.
 */
import type { OrchestrationMessage, ScopedThreadRef } from "@bibcode/contracts";

import { useCenterPanelStore } from "./centerPanelStore";
import { useComposerDraftStore } from "./composerDraftStore";

export const BRING_BACK_HOST_RUNNING_REASON = "Available when the thread is idle.";
export const BRING_BACK_NO_ANSWER_REASON = "Available once the side chat answers.";

type Message = Pick<OrchestrationMessage, "role" | "text" | "streaming">;

const quoteLines = (text: string) =>
  text
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");

/**
 * The stored answer of a Review or Second opinion request, quoted whole under its title, or
 * `null` for an empty answer. The server cut it at 48,000 characters when `truncated`.
 */
export function composeAnswerBringBack(input: {
  readonly targetTitle: string | null;
  readonly action: "review" | "second-opinion";
  readonly answerText: string;
  readonly truncated: boolean;
}): string | null {
  const answer = input.answerText.trim();
  if (answer === "") return null;
  const label = input.action === "review" ? "Review" : "Second opinion";
  const cut = input.truncated ? "\n\n(The answer was cut at 48,000 characters.)" : "";
  return `${label} from ${input.targetTitle?.trim() || "another agent"}:\n\n${quoteLines(answer)}${cut}`;
}

/** The last finished answer, quoted, or `null` before the side chat has answered. */
export function composeSideChatBringBack(messages: ReadonlyArray<Message>): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant" || message.streaming || message.text.trim().length === 0) {
      continue;
    }
    return `From the side chat:\n\n${quoteLines(message.text.trim())}`;
  }
  return null;
}

/** Why **Bring back** is unavailable, or `null`. */
export function resolveBringBackUnavailableReason(input: {
  readonly hostRunning: boolean;
  readonly summary: string | null;
}): string | null {
  if (input.hostRunning) return BRING_BACK_HOST_RUNNING_REASON;
  if (input.summary === null) return BRING_BACK_NO_ANSWER_REASON;
  return null;
}

/** Puts `text` into a thread's composer draft after anything already typed there. Nothing is sent. */
export function appendToComposerDraft(threadRef: ScopedThreadRef, text: string): void {
  const drafts = useComposerDraftStore.getState();
  const current = drafts.getComposerDraft(threadRef)?.prompt ?? "";
  drafts.setPrompt(
    threadRef,
    current.trim().length === 0 ? text : `${current.trimEnd()}\n\n${text}`,
  );
}

/**
 * Puts `summary` into the host's composer draft after anything already typed there, and shows
 * the host chat. Nothing is sent.
 */
export function bringBackToHost(hostRef: ScopedThreadRef, summary: string): void {
  appendToComposerDraft(hostRef, summary);
  useCenterPanelStore.getState().openHostChat(hostRef);
}
