// @vitest-environment happy-dom
import { Terminal } from "@xterm/xterm";
import { expect, it } from "vite-plus/test";

import { terminalBufferText } from "./terminalSource.logic";

const write = (terminal: Terminal, text: string) =>
  new Promise<void>((resolve) => terminal.write(text, resolve));

it("a_wide_character_that_wraps_leaves_no_padding_space", { timeout: 30_000 }, async () => {
  const terminal = new Terminal({ cols: 5, rows: 5, allowProposedApi: true });
  await write(terminal, "abcd界X");
  expect(terminalBufferText(terminal.buffer.active).text).toBe("abcd界X");
  terminal.dispose();
});

it("a_real_trailing_space_of_a_wrapped_row_is_kept", { timeout: 30_000 }, async () => {
  const terminal = new Terminal({ cols: 5, rows: 5, allowProposedApi: true });
  await write(terminal, "abcd efgh");
  expect(terminalBufferText(terminal.buffer.active).text).toBe("abcd efgh");
  terminal.dispose();
});

it("evicted_scrollback_is_reported_as_truncated", { timeout: 60_000 }, async () => {
  const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
  await write(terminal, "LOST\r\n" + "x\r\n".repeat(5100));
  const capacity = 5000 + 24;
  const result = terminalBufferText(terminal.buffer.active, { capacity });
  expect(result.text).not.toContain("LOST");
  expect(result.truncated).toBe(true);
  terminal.dispose();
});

it("a_terminal_that_never_filled_its_scrollback_is_not_truncated", async () => {
  const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
  await write(terminal, "hello\r\n");
  const result = terminalBufferText(terminal.buffer.active, { capacity: 5024 });
  expect(result).toEqual({ text: "hello", truncated: false, usedSource: "output" });
  terminal.dispose();
});
