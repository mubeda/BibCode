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

/** The last finished answer, quoted, or `null` before the side chat has answered. */
export function composeSideChatBringBack(messages: ReadonlyArray<Message>): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant" || message.streaming || message.text.trim().length === 0) {
      continue;
    }
    const quoted = message.text
      .trim()
      .split("\n")
      .map((line) => (line.length === 0 ? ">" : `> ${line}`))
      .join("\n");
    return `From the side chat:\n\n${quoted}`;
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
