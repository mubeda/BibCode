// @vitest-environment happy-dom
import { Terminal } from "@xterm/xterm";
import { expect, it } from "vite-plus/test";
import { activateTerminalUnicode, TERMINAL_BASE_OPTIONS } from "./terminalUnicode";

const write = (terminal: Terminal, text: string) =>
  new Promise<void>((resolve) => terminal.write(text, resolve));

it(
  "advances two columns for U+1F600 with the panel's options and one without Unicode 11",
  { timeout: 30_000 },
  async () => {
    const modern = new Terminal({ ...TERMINAL_BASE_OPTIONS, cols: 20, rows: 5 });
    activateTerminalUnicode(modern);
    await write(modern, "\u{1F600}");
    expect(modern.buffer.active.cursorX).toBe(2);
    expect(modern.unicode.activeVersion).toBe("11");

    // The Unicode 6 widths xterm counts by default.
    const legacy = new Terminal({ ...TERMINAL_BASE_OPTIONS, cols: 20, rows: 5 });
    await write(legacy, "\u{1F600}");
    expect(legacy.buffer.active.cursorX).toBe(1);

    modern.dispose();
    legacy.dispose();
  },
);
