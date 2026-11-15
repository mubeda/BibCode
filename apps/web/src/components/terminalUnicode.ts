import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { ITerminalOptions, Terminal } from "@xterm/xterm";

/** Programs such as the Claude CLI count an emoji as two columns, as Unicode 11 does (#353). */
export const TERMINAL_UNICODE_VERSION = "11";

/**
 * Every terminal's base options. `allowProposedApi` is needed by `terminal.unicode`, which the
 * Unicode 11 addon registers its provider through; it also unlocks `markers`, character
 * joiners and decorations, which the panel does not use.
 */
export const TERMINAL_BASE_OPTIONS = {
  cursorBlink: true,
  macOptionClickForcesSelection: true,
  lineHeight: 1,
  fontSize: 12,
  scrollback: 5_000,
  allowProposedApi: true,
} as const satisfies ITerminalOptions;

export function activateTerminalUnicode(terminal: Pick<Terminal, "loadAddon" | "unicode">): void {
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = TERMINAL_UNICODE_VERSION;
}
