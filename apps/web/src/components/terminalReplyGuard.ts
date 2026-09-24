import type { Terminal } from "@xterm/xterm";

export interface TerminalReplyGuard {
  replay(buffer: string, firstAttachmentGrant?: boolean): void;
  acceptInput(): boolean;
  dispose(): void;
}

export function writeTerminalBuffer(
  terminal: Pick<Terminal, "write">,
  buffer: string,
  onParsed?: () => void,
): void {
  terminal.write("\u001bc", buffer.length === 0 ? onParsed : undefined);
  if (buffer.length > 0) terminal.write(buffer, onParsed);
}

/** Query interception leaves ordinary keystrokes and terminal setters untouched. */
export function installTerminalReplyGuard(
  terminal: Pick<Terminal, "parser" | "write">,
  ownsReplies: () => boolean,
  serverAnswersColors: () => boolean = () => false,
): TerminalReplyGuard {
  let replays = 0;
  let parsingFirstAttachmentGrant = false;
  let disposed = false;
  const suppressClientReply = () => !ownsReplies();
  const parser = terminal.parser;
  const handlers = [
    parser.registerCsiHandler({ final: "c" }, suppressClientReply),
    parser.registerCsiHandler({ prefix: ">", final: "c" }, suppressClientReply),
    parser.registerCsiHandler({ final: "n" }, suppressClientReply),
    parser.registerCsiHandler(
      { prefix: "?", final: "n" },
      // The server handles the in-band color-scheme probe; xterm has no ?996 reply.
      (params) => params[0] === 996 || suppressClientReply(),
    ),
    parser.registerCsiHandler({ intermediates: "$", final: "p" }, suppressClientReply),
    parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, suppressClientReply),
    parser.registerDcsHandler({ intermediates: "$", final: "q" }, suppressClientReply),
    parser.registerOscHandler(4, (data) => suppressClientReply() && data.split(";").includes("?")),
    ...[10, 11, 12].map((code) =>
      parser.registerOscHandler(
        code,
        (data) => (serverAnswersColors() || suppressClientReply()) && data.split(";").includes("?"),
      ),
    ),
  ];
  return {
    replay(buffer, firstAttachmentGrant = false) {
      if (disposed) return;
      let pending = true;
      if (!firstAttachmentGrant) replays += 1;
      try {
        if (firstAttachmentGrant) {
          // Scope permission to parsing this write. A later queued ordinary
          // replay must not suppress this generation's unanswered startup queries.
          terminal.write("", () => {
            if (pending) parsingFirstAttachmentGrant = true;
          });
        }
        // The final write callback covers both RIS and history, including empty histories.
        writeTerminalBuffer(terminal, buffer, () => {
          pending = false;
          if (firstAttachmentGrant) parsingFirstAttachmentGrant = false;
          else replays -= 1;
        });
      } catch (error) {
        pending = false;
        if (firstAttachmentGrant) parsingFirstAttachmentGrant = false;
        else replays -= 1;
        throw error;
      }
    },
    acceptInput: () => !disposed && (replays === 0 || parsingFirstAttachmentGrant),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const handler of handlers) handler.dispose();
    },
  };
}
