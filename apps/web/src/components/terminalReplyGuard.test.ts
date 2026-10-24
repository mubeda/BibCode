// @vitest-environment happy-dom
import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vite-plus/test";
import { installTerminalReplyGuard, writeTerminalBuffer } from "./terminalReplyGuard";

const queries = "\x1b[c\x1b[>c\x1b[5n\x1b[6n\x1b[?6n\x1b[4$p\x1b[?7$p\x1bP$qm\x1b\\\x1b]4;1;?\x07";
const write = (terminal: Terminal, data: string) =>
  new Promise<void>((resolve) => terminal.write(data, resolve));

describe("terminal reply guard", () => {
  it("answers DSR and DA in permitted startup history once and guards later replay", async () => {
    const terminal = new Terminal();
    const guard = installTerminalReplyGuard(terminal, () => true);
    const replies: string[] = [];
    terminal.onData((data) => {
      if (guard.acceptInput()) replies.push(data);
    });
    guard.replay("\x1b[6n\x1b[c", true);
    await write(terminal, "");
    expect(replies).toEqual(["\x1b[1;1R", "\x1b[?1;2c"]);
    guard.replay("\x1b[6n\x1b[c");
    await write(terminal, "");
    expect(replies).toEqual(["\x1b[1;1R", "\x1b[?1;2c"]);
    guard.dispose();
    terminal.dispose();
  });

  it("does not let a later queued guarded replay suppress the permitted startup replies", async () => {
    const terminal = new Terminal();
    const guard = installTerminalReplyGuard(terminal, () => true);
    const replies: string[] = [];
    terminal.onData((data) => {
      if (guard.acceptInput()) replies.push(data);
    });
    guard.replay("\x1b[6n", true);
    guard.replay("\x1b[6n");
    await write(terminal, "");
    expect(replies).toEqual(["\x1b[1;1R"]);
    guard.dispose();
    terminal.dispose();
  });
  it("drops replay replies through the write callback, then permits live replies and typing", async () => {
    const terminal = new Terminal();
    const guard = installTerminalReplyGuard(
      terminal,
      () => true,
      () => true,
    );
    const replies: string[] = [];
    terminal.onData((data) => {
      if (guard.acceptInput()) replies.push(data);
    });
    guard.replay(queries);
    expect(guard.acceptInput()).toBe(false);
    await write(terminal, "");
    expect(replies).toEqual([]);
    expect(guard.acceptInput()).toBe(true);
    await write(terminal, "\x1b[c");
    expect(replies.join("")).toContain("\x1b[?");
    guard.dispose();
    terminal.dispose();
  });

  it("lets only the current owner answer live queries including split sequences", async () => {
    const terminal = new Terminal();
    let owner = false;
    const guard = installTerminalReplyGuard(terminal, () => owner);
    const replies: string[] = [];
    terminal.onData((data) => {
      if (guard.acceptInput()) replies.push(data);
    });
    await write(terminal, queries.slice(0, 2));
    await write(terminal, queries.slice(2));
    expect(replies).toEqual([]);
    owner = true;
    await write(terminal, queries);
    expect(replies.length).toBeGreaterThan(0);
    replies.length = 0;
    owner = false;
    await write(terminal, queries);
    expect(replies).toEqual([]);
    guard.dispose();
    terminal.dispose();
  });

  it("always swallows server-answered queries while preserving ordinary output", async () => {
    const terminal = new Terminal();
    const delegated: string[] = [];
    // Register fallback handlers first so absence of a guard fails even when
    // this xterm version does not implement a particular reply itself.
    terminal.parser.registerCsiHandler({ prefix: "?", final: "n" }, () => {
      delegated.push("DSR");
      return true;
    });
    for (const code of [10, 11, 12])
      terminal.parser.registerOscHandler(code, () => {
        delegated.push(`OSC ${code}`);
        return true;
      });
    const guard = installTerminalReplyGuard(
      terminal,
      () => true,
      () => true,
    );
    const replies: string[] = [];
    terminal.onData((data) => replies.push(data));
    await write(terminal, "\x1b]10;?\x07\x1b]11;?\x1b\\\x1b]12;?\x07\x1b[?996nhello");
    expect(replies).toEqual([]);
    expect(delegated).toEqual([]);
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("hello");
    guard.dispose();
    terminal.dispose();
  });

  it("lets only the owner answer color queries when the snapshot says the server responder is inactive", async () => {
    const terminal = new Terminal();
    const delegated: number[] = [];
    for (const code of [10, 11, 12])
      terminal.parser.registerOscHandler(code, () => {
        delegated.push(code);
        return true;
      });
    let owner = true;
    let serverAnswersColors = false;
    const guard = installTerminalReplyGuard(
      terminal,
      () => owner,
      () => serverAnswersColors,
    );
    const colors = "\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x07";
    await write(terminal, colors);
    expect(delegated).toEqual([10, 11, 12]);
    delegated.length = 0;
    serverAnswersColors = true;
    await write(terminal, colors);
    expect(delegated).toEqual([]);
    serverAnswersColors = false;
    owner = false;
    await write(terminal, colors);
    expect(delegated).toEqual([]);
    guard.dispose();
    terminal.dispose();
  });

  it("lets color setters through for mirrors and owners", async () => {
    for (const owner of [false, true]) {
      const terminal = new Terminal();
      const setters: string[] = [];
      for (const code of [4, 10, 11, 12])
        terminal.parser.registerOscHandler(code, (data) => {
          setters.push(data);
          return true;
        });
      const guard = installTerminalReplyGuard(terminal, () => owner);
      await write(
        terminal,
        "\x1b]4;1;#ff0000\x07\x1b]10;#ffffff\x07\x1b]11;#000000\x07\x1b]12;#000000\x07",
      );
      expect(setters).toEqual(["1;#ff0000", "#ffffff", "#000000", "#000000"]);
      guard.dispose();
      terminal.dispose();
    }
  });

  it("keeps the replay guard active until every queued reset has parsed", () => {
    const callbacks: Array<() => void> = [];
    const disposable = { dispose() {} };
    const guard = installTerminalReplyGuard(
      {
        write: (_data, callback) => {
          if (callback) callbacks.push(callback);
        },
        parser: {
          registerEscHandler: () => disposable,
          registerCsiHandler: () => disposable,
          registerOscHandler: () => disposable,
          registerDcsHandler: () => disposable,
        },
      },
      () => true,
    );
    guard.replay("first");
    guard.replay("second");
    callbacks[0]!();
    expect(guard.acceptInput()).toBe(false);
    callbacks[1]!();
    expect(guard.acceptInput()).toBe(true);
    guard.dispose();
    expect(guard.acceptInput()).toBe(false);
  });
});

describe("exited shell replay", () => {
  const inputModes = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?2004h";
  const replayed = async (history: string, exited: boolean) => {
    const terminal = new Terminal();
    const guard = installTerminalReplyGuard(terminal, () => true);
    guard.replay(history, false, exited);
    await write(terminal, "");
    guard.dispose();
    return terminal;
  };

  it("turns off the input modes a dead shell left on", async () => {
    const terminal = await replayed(`${inputModes}$ exit\r\n`, true);
    expect(terminal.modes.mouseTrackingMode).toBe("none");
    expect(terminal.modes.sendFocusMode).toBe(false);
    expect(terminal.modes.bracketedPasteMode).toBe(false);
    expect(terminal.buffer.active.type).toBe("normal");
    terminal.dispose();
  });

  it("keeps a running program's modes", async () => {
    const terminal = await replayed(`\x1b[?1049h${inputModes}tui`, false);
    expect(terminal.modes.mouseTrackingMode).toBe("any");
    expect(terminal.modes.sendFocusMode).toBe(true);
    expect(terminal.modes.bracketedPasteMode).toBe(true);
    expect(terminal.buffer.active.type).toBe("alternate");
    terminal.dispose();
  });

  // Only 1049 saves and restores the main cursor; 47 and 1047 keep the program's.
  it.each([
    ["\x1b[?1049h", [0, 1]],
    ["\x1b[?1049;1000h", [0, 1]],
    ["\x1b[?01049h", [0, 1]],
    ["\x1b[?1047h", [3, 1]],
    ["\x1b[?47h", [3, 1]],
  ])("leaves the alternate screen entered with %j the same way", async (enter, cursor) => {
    const terminal = await replayed(`main\r\n${enter}tui`, true);
    expect(terminal.buffer.active.type).toBe("normal");
    expect([terminal.buffer.active.cursorX, terminal.buffer.active.cursorY]).toEqual(cursor);
    expect(terminal.modes.mouseTrackingMode).toBe("none");
    terminal.dispose();
  });

  it("does not restore a stale saved cursor on the main screen", async () => {
    // The shell saved the cursor at the top, printed two lines, then exited.
    const terminal = await replayed("\x1b7\x1b[?2004hone\r\ntwo\r\n$ ", true);
    expect(terminal.buffer.active.type).toBe("normal");
    expect([terminal.buffer.active.cursorX, terminal.buffer.active.cursorY]).toEqual([2, 2]);
    expect(terminal.modes.bracketedPasteMode).toBe(false);
    terminal.dispose();
  });

  it("keeps the main cursor after a program already left the alternate screen", async () => {
    const terminal = await replayed("one\r\n$ \x1b[?1049hfull\x1b[?1049l\r\n$ \x1b[?1000h", true);
    expect(terminal.buffer.active.type).toBe("normal");
    expect([terminal.buffer.active.cursorX, terminal.buffer.active.cursorY]).toEqual([2, 2]);
    expect(terminal.modes.mouseTrackingMode).toBe("none");
    terminal.dispose();
  });

  it("writes the reset after the history, and only for escape-bearing exited history", () => {
    const writes: Array<[string, boolean]> = [];
    const terminal = {
      write: (data: string, callback?: () => void) => writes.push([data, callback !== undefined]),
    };
    const onParsed = () => {};

    writeTerminalBuffer(terminal, "plain output\r\n", onParsed, true);
    expect(writes).toEqual([
      ["\x1bc", false],
      ["plain output\r\n", true],
    ]);

    writes.length = 0;
    writeTerminalBuffer(terminal, "\x1b[?1000hmouse", onParsed, false);
    expect(writes).toEqual([
      ["\x1bc", false],
      ["\x1b[?1000hmouse", true],
    ]);

    writes.length = 0;
    writeTerminalBuffer(terminal, "\x1b[?1000hmouse", onParsed, true);
    expect(writes.map(([data]) => data).slice(0, 2)).toEqual(["\x1bc", "\x1b[?1000hmouse"]);
    expect(writes[1]![1]).toBe(false);
    expect(writes).toHaveLength(3);
    expect(writes[2]![0]).toContain("1000");
    expect(writes[2]![1]).toBe(true);
  });
});
