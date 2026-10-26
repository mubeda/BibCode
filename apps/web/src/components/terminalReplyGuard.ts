import type { Terminal } from "@xterm/xterm";

export interface TerminalReplyGuard {
  replay(buffer: string, firstAttachmentGrant?: boolean, exited?: boolean): void;
  acceptInput(): boolean;
  dispose(): void;
}

// Turns off what a dead program may have left on: cursor-key and keypad
// application modes, every mouse protocol and encoding, focus reports and
// bracketed paste. Then shows the cursor and pops Kitty keyboard flags and
// modifyOtherKeys, which xterm ignores today.
const EXITED_MODE_RESET =
  "\u001b[?1;9;66;1000;1002;1003;1004;1005;1006;1015;1016;2004l" +
  "\u001b[?25h\u001b[<100u\u001b[=0;1u\u001b[>4m";
// oxlint-disable-next-line no-control-regex -- Matches replayed DEC private modes and RIS.
const SCREEN_CONTROLS = /\u001b(?:\[\?([0-9;]*)([hl])|(c))/g;

/**
 * The reset written after an exited session's history. RIS precedes the
 * history, so scanning it shows the screen xterm ends on. Only a history that
 * ends on the alternate screen gets an exit, with the mode that entered it: a
 * `?1049l` on the main screen would restore a stale saved cursor. Saving the
 * cursor first keeps that exit harmless if the scan is ever wrong.
 */
function exitedReplaySuffix(history: string): string {
  if (!history.includes("\u001b")) return "";
  let alternateScreen: number | undefined;
  for (const [, params, set, reset] of history.matchAll(SCREEN_CONTROLS)) {
    if (reset) alternateScreen = undefined;
    // Numeric like xterm's parser, so `?01049h` is 1049.
    for (const mode of params?.split(";").map(Number) ?? []) {
      if (mode === 47 || mode === 1047 || mode === 1049) {
        alternateScreen = set === "h" ? (alternateScreen ?? mode) : undefined;
      }
    }
  }
  const leaveAlternateScreen =
    alternateScreen === undefined ? "" : `\u001b7\u001b[?${alternateScreen}l`;
  return leaveAlternateScreen + EXITED_MODE_RESET;
}

export function writeTerminalBuffer(
  terminal: Pick<Terminal, "write">,
  buffer: string,
  onParsed?: () => void,
  exited = false,
): void {
  // A live program still uses the modes its history enabled; only a dead one's are reset.
  const suffix = exited ? exitedReplaySuffix(buffer) : "";
  terminal.write("\u001bc", buffer.length === 0 ? onParsed : undefined);
  if (buffer.length > 0) terminal.write(buffer, suffix.length === 0 ? onParsed : undefined);
  if (suffix.length > 0) terminal.write(suffix, onParsed);
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
    replay(buffer, firstAttachmentGrant = false, exited = false) {
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
        // The final write callback covers RIS, history and any exited-mode
        // reset, including empty histories.
        writeTerminalBuffer(
          terminal,
          buffer,
          () => {
            pending = false;
            if (firstAttachmentGrant) parsingFirstAttachmentGrant = false;
            else replays -= 1;
          },
          exited,
        );
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
