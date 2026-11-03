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

const QUESTION_MAX_CHARS = 120;

type Message = Pick<OrchestrationMessage, "role" | "text" | "streaming">;

/**
 * The quoted summary of the last finished answer and the question before it, or `null` before
 * the side chat has answered.
 */
export function composeSideChatBringBack(messages: ReadonlyArray<Message>): string | null {
  let answerIndex = messages.length - 1;
  while (answerIndex >= 0) {
    const message = messages[answerIndex]!;
    if (message.role === "assistant" && !message.streaming && message.text.trim().length > 0) {
      break;
    }
    answerIndex -= 1;
  }
  if (answerIndex < 0) return null;
  const answer = messages[answerIndex]!.text.trim();
  let question: string | undefined;
  for (let index = answerIndex - 1; index >= 0 && question === undefined; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user") question = message.text.trim().split("\n", 1)[0]?.trim();
  }
  const asked =
    question === undefined || question.length === 0
      ? ""
      : question.length > QUESTION_MAX_CHARS
        ? ` (asked: ${question.slice(0, QUESTION_MAX_CHARS - 3)}...)`
        : ` (asked: ${question})`;
  const quoted = answer
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
  return `From the side chat${asked}:\n\n${quoted}`;
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

/**
 * Puts `summary` into the host's composer draft after anything already typed there, and shows
 * the host chat. Nothing is sent.
 */
export function bringBackToHost(hostRef: ScopedThreadRef, summary: string): void {
  const drafts = useComposerDraftStore.getState();
  const current = drafts.getComposerDraft(hostRef)?.prompt ?? "";
  drafts.setPrompt(
    hostRef,
    current.trim().length === 0 ? summary : `${current.trimEnd()}\n\n${summary}`,
  );
  useCenterPanelStore.getState().openHostChat(hostRef);
}
