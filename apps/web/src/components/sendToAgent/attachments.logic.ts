/**
 * What a Second opinion attaches: the person's last message and the last finished answer of the
 * panel, each cut at 16,000 characters with the count left out, so the person sees exactly what
 * the other agent will read.
 */
import {
  isPersonMessage,
  type PreviewAttachment,
  type SendToAgentSource,
} from "./sendToAgent.logic";

export const ATTACHMENT_MAX_CHARS = 16_000;

export const SECOND_OPINION_LEAD_IN =
  "A second opinion was requested from BiBCode. Below are the last message the user sent to another agent and that agent's last finished answer. Assess the answer: say what is right, what is wrong or missing, and what you would do differently. Do not edit files and do not run commands that change anything.";

type Messages = SendToAgentSource["messages"];

/** Keeps the first `limit` Unicode scalar values, as the server counts them; a UTF-16 slice could split a pair. */
export function cutAtCharacters(text: string, limit: number): { text: string; leftOut: number } {
  const characters = Array.from(text);
  if (characters.length <= limit) return { text, leftOut: 0 };
  return { text: characters.slice(0, limit).join(""), leftOut: characters.length - limit };
}

export function formatLeftOut(leftOut: number): string | null {
  if (leftOut <= 0) return null;
  return `${leftOut.toLocaleString("en-US")} ${leftOut === 1 ? "character" : "characters"} left out`;
}

function lastMatching(
  messages: Messages,
  matches: (message: Messages[number]) => boolean,
): { id: string; text: string } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (matches(message) && message.text.trim() !== "") {
      return { id: message.id, text: message.text.trim() };
    }
  }
  return null;
}

/** An agent's envelope is a user-role message with an actor, so it is never the person's. */
export function lastPersonMessage(messages: Messages): { id: string; text: string } | null {
  return lastMatching(messages, isPersonMessage);
}

export function lastFinishedAnswer(messages: Messages): { id: string; text: string } | null {
  return lastMatching(messages, (message) => message.role === "assistant" && !message.streaming);
}

function attachment(
  id: string,
  label: string,
  found: { text: string } | null,
): ReadonlyArray<PreviewAttachment> {
  if (found === null) return [];
  const cut = cutAtCharacters(found.text, ATTACHMENT_MAX_CHARS);
  return [{ id, label, text: cut.text, leftOut: formatLeftOut(cut.leftOut) }];
}

export function buildSecondOpinionContent(messages: Messages): {
  leadIn: string;
  attachments: ReadonlyArray<PreviewAttachment>;
} {
  return {
    leadIn: SECOND_OPINION_LEAD_IN,
    attachments: [
      ...attachment("last-user-message", "The user's last message", lastPersonMessage(messages)),
      ...attachment(
        "last-answer",
        "The agent's last finished answer",
        lastFinishedAnswer(messages),
      ),
    ],
  };
}
