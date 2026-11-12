// @vitest-environment happy-dom
import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createTerminalFollowOutput, type TerminalFollowOutput } from "./terminalFollowOutput";

const write = (terminal: Terminal, data: string) =>
  new Promise<void>((resolve) => terminal.write(data, resolve));
const lines = (count: number, from = 0) =>
  Array.from({ length: count }, (_, index) => `line ${from + index}\r\n`).join("");
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * An unopened xterm keeps a real buffer but never renders, so the test drives what an opened
 * one does in a browser: the observer's pause, the paused clamp (a scroll nobody asked for),
 * frames and renders.
 */
function harness() {
  const terminal = new Terminal({ cols: 46, rows: 43, scrollback: 5000, allowProposedApi: true });
  let setDrawing: (drawing: boolean) => void = () => undefined;
  let frames: Array<() => void> = [];
  const renders = new Set<() => void>();
  const follow = createTerminalFollowOutput(
    {
      buffer: terminal.buffer,
      scrollToBottom: () => terminal.scrollToBottom(),
      onRender: (listener) => {
        const callback = () => listener({ start: 0, end: terminal.rows - 1 });
        renders.add(callback);
        return { dispose: () => renders.delete(callback) };
      },
    },
    {
      observeDrawing: (onChange) => {
        setDrawing = onChange;
        return () => (setDrawing = () => undefined);
      },
      scheduleFrame: (callback) => frames.push(callback),
      cancelFrame: (handle) => {
        frames[handle - 1] = () => undefined;
      },
    },
  );
  const runFrames = () => {
    for (let index = 0; index < 3; index += 1) {
      const pending = frames;
      frames = [];
      for (const frame of pending) frame();
    }
  };
  return {
    terminal,
    follow,
    pause: () => setDrawing(false),
    resume: () => setDrawing(true),
    render: () => [...renders].forEach((callback) => callback()),
    runFrames,
    /** What xterm 6's paused viewport does after a row shrink: moves the view up by itself. */
    clamp: (rows: number) => terminal.scrollLines(-rows),
    position: () => [terminal.buffer.normal.viewportY, terminal.buffer.normal.baseY],
  };
}

const opened: Array<{ terminal: Terminal; follow: TerminalFollowOutput }> = [];
afterEach(() => {
  for (const { terminal, follow } of opened.splice(0)) {
    follow.dispose();
    terminal.dispose();
  }
});
async function setUp() {
  const test = harness();
  opened.push(test);
  await write(test.terminal, lines(300));
  return test;
}

describe("terminal follow output across a paused renderer (#348)", () => {
  it("returns a view that followed the output to the bottom after a paused shrink and scroll", async () => {
    const test = await setUp();
    test.pause();
    test.terminal.resize(46, 26);
    test.clamp(18);
    await write(test.terminal, lines(2, 300));
    // applySize asks while paused: the record says it followed, though the view has drifted.
    expect(test.follow.atBottom()).toBe(true);
    const [driftedY, baseY] = test.position();
    expect(driftedY).toBeLessThan(baseY!);

    test.resume();
    test.render();
    await tick();
    const [viewportY, bottom] = test.position();
    expect(viewportY).toBe(bottom);
    expect(test.follow.atBottom()).toBe(true);
  });

  it("repairs after two frames when the resumed renderer draws nothing", async () => {
    const test = await setUp();
    test.pause();
    test.clamp(10);
    test.resume();
    await tick();
    expect(test.position()[0]).toBeLessThan(test.position()[1]!);
    test.runFrames();
    await tick();
    expect(test.position()[0]).toBe(test.position()[1]);
  });

  it("keeps a view the user scrolled up before the pause", async () => {
    const test = await setUp();
    test.terminal.scrollLines(-30);
    test.pause();
    test.terminal.resize(46, 26);
    await write(test.terminal, lines(5, 300));
    expect(test.follow.atBottom()).toBe(false);
    const before = test.position()[0];
    expect(before).toBeLessThan(test.position()[1]!);
    test.resume();
    test.render();
    await tick();
    expect(test.position()[0]).toBe(before);
    expect(test.follow.atBottom()).toBe(false);
  });

  it("does not let the alternate screen change the record and repairs when it ends", async () => {
    const test = await setUp();
    test.pause();
    test.clamp(12);
    await write(test.terminal, "\u001b[?1049halternate screen\r\n");
    test.resume();
    test.render();
    await tick();
    // The alternate screen shows no scrollback: the normal buffer waits.
    expect(test.terminal.buffer.active.type).toBe("alternate");
    expect(test.follow.atBottom()).toBe(true);
    expect(test.position()[0]).toBeLessThan(test.position()[1]!);
    await write(test.terminal, "\u001b[?1049l");
    await tick();
    expect(test.position()[0]).toBe(test.position()[1]);
  });

  it("keeps a scrolled-up record through an alternate screen entered while paused", async () => {
    const test = await setUp();
    test.terminal.scrollLines(-20);
    const before = test.position()[0];
    test.pause();
    await write(test.terminal, "\u001b[?1049h\u001b[?1049l");
    test.resume();
    test.render();
    await tick();
    expect(test.position()[0]).toBe(before);
  });

  it("repairs after a snapshot reset on the same terminal", async () => {
    const test = await setUp();
    test.pause();
    await write(test.terminal, `\u001bc${lines(400)}`);
    test.clamp(15);
    test.resume();
    test.render();
    await tick();
    expect(test.position()[0]).toBe(test.position()[1]);
  });

  it("keeps the record when another renderer draws the resume (WebGL to DOM fallback)", async () => {
    const test = await setUp();
    test.pause();
    test.clamp(9);
    test.resume();
    // The fallback swaps the renderer, not the terminal: its first render ends the wait.
    test.render();
    await tick();
    expect(test.position()[0]).toBe(test.position()[1]);
  });

  it("does nothing after dispose", async () => {
    const test = await setUp();
    test.pause();
    test.clamp(9);
    test.resume();
    test.follow.dispose();
    test.render();
    test.runFrames();
    await tick();
    expect(test.position()[0]).toBeLessThan(test.position()[1]!);
  });
});
