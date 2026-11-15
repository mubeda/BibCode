/**
 * What Hand off and Take over from attach: a thread's handoff text, which the server builds from
 * its stored messages (the person's first message, a marked gap, the latest messages), so nothing
 * is sent to the agent whose work moves. A picked terminal agent attaches its terminal text.
 */
import type { ThreadId } from "@bibcode/contracts";

import type { AgentRow } from "../sidebar/agentsSection.logic";
import { ATTACHMENT_MAX_CHARS, cutAtCharacters, formatLeftOut } from "./attachments.logic";
import type { PreviewAttachment, PreviewContent, SendToAgentSource } from "./sendToAgent.logic";
import {
  TERMINAL_OUTPUT_LOAD_FAILED_MESSAGE,
  TERMINAL_OUTPUT_LOADING_MESSAGE,
} from "./terminalSource.logic";

// Defined beside `submitSendChoice`, its only caller, so the two modules do not import each other.
export { resolveRequestRoles } from "./sendToAgent.logic";

export const HAND_OFF_LEAD_IN =
  "The user is handing work over to you from another BiBCode thread. Below is that thread's first message and its most recent messages. Continue the work from there.";
export const TAKE_OVER_LEAD_IN =
  "The user is continuing in this thread after another agent. Below is that agent's first message and its most recent messages, read from BiBCode's stored history. Continue the work from there.";
export const TERMINAL_NOT_READABLE_WARNING =
  "This terminal's text cannot be read from here yet. Describe what it was doing in the note.";
export const TERMINAL_FELL_BACK_NOTE =
  "The conversation could not be read, so this is recent terminal output.";
export const TERMINAL_START_MISSING_NOTE = "The start of the conversation is not included.";

export type HandoffLoader = (
  threadId: ThreadId,
) => Promise<{ text: string; leftOut: number; includedMessages: number }>;

export type TerminalOutputLoader = (row: AgentRow) => Promise<{
  text: string;
  truncated: boolean;
  usedSource: "output" | "conversation";
  fellBack: boolean;
  startMissing: boolean;
}>;

export function formatLeftOutMessages(leftOut: number): string | null {
  if (leftOut <= 0) return null;
  return `${leftOut.toLocaleString("en-US")} earlier ${leftOut === 1 ? "message" : "messages"} left out`;
}

async function handoffAttachments(
  title: string,
  threadId: ThreadId,
  loadHandoff: HandoffLoader,
): Promise<ReadonlyArray<PreviewAttachment>> {
  const handoff = await loadHandoff(threadId);
  return [
    {
      id: "handoff",
      label: `Handoff from ${title}`,
      text: handoff.text,
      leftOut: formatLeftOutMessages(handoff.leftOut),
    },
  ];
}

export function buildHandOffContent(input: {
  source: SendToAgentSource;
  loadHandoff: HandoffLoader;
}): PreviewContent {
  const { source, loadHandoff } = input;
  return {
    leadIn: HAND_OFF_LEAD_IN,
    attachments: [],
    loadAttachments: () => handoffAttachments(source.title, source.threadId, loadHandoff),
  };
}

/** The picked agent only supplies text; the request goes to the source's own agent. */
export function buildTakeOverContent(input: {
  source: SendToAgentSource;
  picked: AgentRow;
  loadHandoff: HandoffLoader;
  loadTerminalOutput: TerminalOutputLoader | null;
}): PreviewContent {
  const { picked, loadHandoff, loadTerminalOutput } = input;
  if (picked.terminalId === null) {
    return {
      leadIn: TAKE_OVER_LEAD_IN,
      attachments: [],
      loadAttachments: () =>
        handoffAttachments(picked.shell.title, picked.ref.threadId, loadHandoff),
    };
  }
  if (loadTerminalOutput === null) {
    return { leadIn: TAKE_OVER_LEAD_IN, attachments: [], warning: TERMINAL_NOT_READABLE_WARNING };
  }
  return {
    leadIn: TAKE_OVER_LEAD_IN,
    attachments: [],
    loadFailedMessage: TERMINAL_OUTPUT_LOAD_FAILED_MESSAGE,
    loadingMessage: TERMINAL_OUTPUT_LOADING_MESSAGE,
    loadAttachments: async () => {
      const output = await loadTerminalOutput(picked);
      const cut = cutAtCharacters(output.text, ATTACHMENT_MAX_CHARS);
      const notes = [
        output.fellBack ? TERMINAL_FELL_BACK_NOTE : null,
        output.startMissing ? TERMINAL_START_MISSING_NOTE : null,
      ].filter((note) => note !== null);
      return [
        {
          id: "terminal-output",
          label:
            output.usedSource === "conversation"
              ? "Terminal conversation"
              : "Recent terminal output",
          text: cut.text,
          leftOut: formatLeftOut(cut.leftOut),
          note: notes.length === 0 ? null : notes.join(" "),
        },
      ];
    },
  };
}
