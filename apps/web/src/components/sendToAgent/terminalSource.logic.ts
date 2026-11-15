/**
 * An AI Terminal as the source of a request: which terminals offer Send to agent, and the text a
 * Second opinion or Hand off attaches from one (the selection, else the recent output). Nothing
 * here writes to the terminal.
 */
import type {
  SendRequestsGetTerminalOutputInput,
  SendRequestsGetTerminalOutputResult,
  TerminalSummary,
  ThreadId,
} from "@bibcode/contracts";

import {
  ATTACHMENT_MAX_CHARS,
  cutAtCharacters,
  formatLeftOut,
  keepLastCharacters,
} from "./attachments.logic";
import type { TerminalOutputLoader } from "./handoff.logic";
import type { PreviewAttachment } from "./sendToAgent.logic";

export const TERMINAL_OUTPUT_TRUNCATED_NOTE = "Only the most recent output is included.";
export const TERMINAL_OUTPUT_LOAD_FAILED_MESSAGE =
  "BiBCode could not read this terminal's output. Try again.";
export const TERMINAL_OUTPUT_LOADING_MESSAGE = "Reading the terminal's output to attach";

/** An AI Terminal reports an agent status and was launched with an activity; a shell has neither. */
export function isAiTerminal(
  summary: Pick<TerminalSummary, "agentStatus" | "command"> | null | undefined,
): boolean {
  return summary?.agentStatus !== undefined && summary.command?.activity !== undefined;
}

export interface TerminalOutputText {
  text: string;
  truncated: boolean;
  usedSource: "output" | "conversation";
}

/** The part of xterm's buffer the text is read from; `IBuffer` satisfies it. */
export interface TerminalBufferLike {
  readonly type: "normal" | "alternate";
  readonly length: number;
  getLine(index: number): TerminalBufferRowLike | undefined;
}

export interface TerminalBufferRowLike {
  readonly isWrapped: boolean;
  readonly length?: number;
  translateToString(trimRight?: boolean): string;
  getCell?(x: number): { getChars(): string; getWidth(): number } | undefined;
}

/** When a wide character did not fit, xterm leaves an empty cell at the row's end; it is not text. */
function endsInWidePadding(row: TerminalBufferRowLike, next: TerminalBufferRowLike): boolean {
  const last = row.getCell?.((row.length ?? 0) - 1);
  return last !== undefined && last.getChars() === "" && next.getCell?.(0)?.getWidth() === 2;
}

/**
 * The text a person sees in a terminal, read from its rendered buffer: scrollback and screen for
 * the normal buffer, the screen for the alternate one. The server's raw tail is garbled for an
 * app that repaints with cursor movement, so a mounted terminal reads here instead. Wrapped rows
 * are joined, trailing blank rows dropped, and the end is kept at `limit` characters. The
 * alternate buffer keeps no history, so it always says older output is missing.
 */
export function terminalBufferText(
  buffer: TerminalBufferLike,
  options: {
    limit?: number;
    /** Rows the buffer holds before xterm drops the oldest: scrollback plus screen rows. */
    capacity?: number;
  } = {},
): TerminalOutputText {
  const { limit = ATTACHMENT_MAX_CHARS, capacity } = options;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    const row = buffer.getLine(index);
    if (row === undefined) continue;
    // A row that continues on the next one keeps its trailing spaces: they are part of the text.
    const next = buffer.getLine(index + 1);
    const continues = next?.isWrapped === true;
    let text = row.translateToString(!continues);
    if (continues && endsInWidePadding(row, next)) text = text.slice(0, -1);
    if (row.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  const kept = keepLastCharacters(lines.join("\n"), limit);
  // A cut can land inside a grapheme; a combining mark with no base would lead the text.
  const text = kept.leftOut > 0 ? kept.text.replace(/^\p{M}+/u, "") : kept.text;
  // A full normal buffer has already dropped its oldest rows.
  const evicted = buffer.type === "normal" && capacity !== undefined && buffer.length >= capacity;
  return {
    text,
    truncated: kept.leftOut > 0 || evicted || buffer.type === "alternate",
    usedSource: "output",
  };
}

export function terminalHasText(
  selection: string | null,
  output: Pick<TerminalOutputText, "text"> | null,
): boolean {
  return (selection ?? "").trim() !== "" || (output?.text ?? "").trim() !== "";
}

/** The selection wins over the output; empty text attaches nothing. */
export function terminalAttachment(input: {
  selection: string | null;
  output: TerminalOutputText | null;
  terminalLabel: string;
}): PreviewAttachment | null {
  const { selection, output, terminalLabel } = input;
  if (selection !== null && selection.trim() !== "") {
    const cut = cutAtCharacters(selection, ATTACHMENT_MAX_CHARS);
    return {
      id: "terminal-selection",
      label: `Selection from ${terminalLabel}`,
      text: cut.text,
      leftOut: formatLeftOut(cut.leftOut),
    };
  }
  if (output === null || output.text.trim() === "") return null;
  const cut = cutAtCharacters(output.text, ATTACHMENT_MAX_CHARS);
  return {
    id: "terminal-output",
    label:
      output.usedSource === "conversation"
        ? `Conversation of ${terminalLabel}`
        : `Recent output of ${terminalLabel}`,
    text: cut.text,
    leftOut: formatLeftOut(cut.leftOut),
    note: output.truncated ? TERMINAL_OUTPUT_TRUNCATED_NOTE : null,
  };
}

/**
 * Fills the loader Take over from needs for a picked terminal agent. It asks for the CLI's
 * conversation; the server answers with the output and `fellBack` until it can read one.
 */
export function makeTerminalOutputLoader(
  read: (input: SendRequestsGetTerminalOutputInput) => Promise<SendRequestsGetTerminalOutputResult>,
  sourceThreadId: ThreadId,
): TerminalOutputLoader {
  return async (row) => {
    if (row.terminalId === null) throw new Error("This agent is not a terminal.");
    const result = await read({
      sourceThreadId,
      threadId: row.ref.threadId,
      terminalId: row.terminalId,
      source: "conversation",
      part: "handoff",
    });
    return {
      text: result.text,
      truncated: result.truncated,
      usedSource: result.usedSource,
      fellBack: result.fellBack,
      startMissing: result.startMissing,
    };
  };
}

/**
 * Whether a panel made for a send becomes the active tab at once. It stays inactive while
 * activating it would unmount the source and its open preview: a panel that is not the host, or a
 * terminal in the center panel. The caller reveals it after the send succeeded.
 */
export function shouldActivateSendPanel(input: {
  hostThreadId: ThreadId | null;
  sourceUnmountsOnActivate: boolean;
}): boolean {
  return input.hostThreadId === null && !input.sourceUnmountsOnActivate;
}
