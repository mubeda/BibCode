import type { PipelinesJobLog } from "@bibcode/contracts";
import { PullRequestsOperationError } from "@bibcode/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { utf8Length, type JobLogLayout } from "./jobLog.parse";
import { createMainThreadJobLogEngine } from "./jobLogEngine";
import {
  JobLogReader,
  LOG_CATCH_UP_READS,
  LOG_CLIENT_CAP,
  type JobLogReaderState,
  type LogReadAnswer,
  type LogReadInput,
} from "./jobLogReader";

const WINDOW = 512_000;

function chunkAt(
  text: string,
  offset: number,
  options: Partial<Extract<PipelinesJobLog, { _tag: "chunk" }>> = {},
): PipelinesJobLog {
  return {
    _tag: "chunk",
    text,
    offset,
    nextOffset: offset + utf8Length(text),
    totalBytes: null,
    complete: false,
    truncatedHead: false,
    firstLine: offset === 0 ? 0 : null,
    ...options,
  };
}

/** A full ranged window of `lines` short lines starting at `offset`. */
function fullWindow(offset: number): PipelinesJobLog {
  const line = `${"x".repeat(99)}\n`;
  return chunkAt(line.repeat(WINDOW / line.length), offset);
}

const readers: JobLogReader[] = [];
afterEach(() => {
  for (const reader of readers.splice(0)) reader.dispose();
  vi.useRealTimers();
});

function harness(options: { live: boolean; at?: number | null }) {
  const reads: LogReadInput[] = [];
  const answers: LogReadAnswer[] = [];
  let waiting: ((answer: LogReadAnswer) => void) | null = null;
  const states: JobLogReaderState[] = [];
  const layouts: JobLogLayout[] = [];
  const reader = new JobLogReader({
    read: (input) => {
      reads.push(input);
      const next = answers.shift();
      if (next) return Promise.resolve(next);
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    engine: createMainThreadJobLogEngine(() => Promise.resolve()),
    live: options.live,
    at: options.at ?? null,
    onLayout: (layout) => layouts.push(layout),
    onState: (state) => states.push(state),
  });
  readers.push(reader);
  return {
    reader,
    reads,
    layouts,
    queue: (...next: PipelinesJobLog[]) =>
      answers.push(...next.map((log) => ({ _tag: "answer", log }) as const)),
    fail: (error: PullRequestsOperationError) =>
      answers.push({ _tag: "failure", error, message: error.message }),
    answer: (log: PipelinesJobLog) => {
      const resolve = waiting;
      waiting = null;
      resolve?.({ _tag: "answer", log });
    },
    get state() {
      return reader.current;
    },
    settle: async () => {
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
      else await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe("job log reader", () => {
  it("opens a finished log on its tail and reads nothing more once it is complete", async () => {
    const h = harness({ live: false });
    h.queue(chunkAt("last line\n", 40_000, { complete: true, totalBytes: 40_010 }));
    h.reader.open();
    await h.settle();
    expect(h.reads).toEqual([{ from: { _tag: "tail" }, refresh: "user" }]);
    expect(h.state).toMatchObject({ phase: "done", complete: true, totalBytes: 40_010 });
    h.reader.tick();
    expect(h.reads).toHaveLength(1);
  });

  it("catches a running log up at most three times, then follows it", async () => {
    const h = harness({ live: true });
    h.queue(fullWindow(0), fullWindow(WINDOW), fullWindow(2 * WINDOW), fullWindow(3 * WINDOW));
    h.reader.open();
    await h.settle();
    expect(h.reads).toHaveLength(1 + LOG_CATCH_UP_READS);
    expect(h.reads.slice(1)).toEqual([
      { from: { _tag: "offset", offset: WINDOW }, refresh: "follow" },
      { from: { _tag: "offset", offset: 2 * WINDOW }, refresh: "follow" },
      { from: { _tag: "offset", offset: 3 * WINDOW }, refresh: "follow" },
    ]);
    expect(h.state.phase).toBe("following");
    h.queue(chunkAt("new\n", 4 * WINDOW));
    h.reader.tick();
    await h.settle();
    expect(h.reads.at(-1)).toEqual({
      from: { _tag: "offset", offset: 4 * WINDOW },
      refresh: "follow",
    });
    expect(h.state.range).toEqual({ start: 0, end: 4 * WINDOW + 4 });
  });

  it("keeps the loaded head of a too-large running log and reads nothing until it finishes", async () => {
    const h = harness({ live: true });
    h.queue(fullWindow(0), fullWindow(WINDOW), fullWindow(2 * WINDOW), {
      _tag: "unavailable",
      reason: "too_large_live",
      url: "https://gitlab.example/j/1/raw",
    });
    h.reader.open();
    await h.settle();
    expect(h.state.phase).toBe("paused_large");
    expect(h.state.range).toEqual({ start: 0, end: 3 * WINDOW });
    h.reader.tick();
    expect(h.reads).toHaveLength(4);
    h.queue(chunkAt("the end\n", 9_000_000, { complete: true, totalBytes: 9_000_008 }));
    h.reader.setLive(false);
    await h.settle();
    expect(h.reads.at(-1)).toEqual({ from: { _tag: "tail" }, refresh: "user" });
    expect(h.state).toMatchObject({ phase: "done", range: { start: 9_000_000, end: 9_000_008 } });
    expect(h.layouts.at(-1)!.lineCount).toBe(1);
  });

  it("makes one final read when a followed job finishes, then stops", async () => {
    const h = harness({ live: true });
    h.queue(chunkAt("start\n", 0));
    h.reader.open();
    await h.settle();
    h.queue(chunkAt("done\n", 6, { complete: true, totalBytes: 11 }));
    h.reader.setLive(false);
    await h.settle();
    expect(h.reads.at(-1)).toEqual({ from: { _tag: "offset", offset: 6 }, refresh: "user" });
    expect(h.state.phase).toBe("done");
    h.reader.tick();
    expect(h.reads).toHaveLength(2);
  });

  it("reads the rest after a job finished while a follow read was out", async () => {
    const h = harness({ live: true });
    h.queue(chunkAt("start\n", 0));
    h.reader.open();
    await h.settle();
    h.reader.tick();
    h.reader.setLive(false);
    h.queue(chunkAt("rest\n", 11, { complete: true, totalBytes: 16 }));
    h.answer(chunkAt("more\n", 6));
    await h.settle();
    expect(h.reads.map((read) => read.from)).toEqual([
      { _tag: "tail" },
      { _tag: "offset", offset: 6 },
      { _tag: "offset", offset: 11 },
    ]);
    expect(h.state.phase).toBe("done");
  });

  it("re-reads the tail of a job that has not printed yet, until it does", async () => {
    const h = harness({ live: true });
    h.queue({ _tag: "unavailable", reason: "not_started", url: null });
    h.reader.open();
    await h.settle();
    expect(h.state.phase).toBe("waiting_start");
    h.queue(chunkAt("hello\n", 0));
    h.reader.tick();
    await h.settle();
    expect(h.reads.at(-1)).toEqual({ from: { _tag: "tail" }, refresh: "follow" });
    expect(h.state).toMatchObject({ phase: "following", unavailable: null });
  });

  it("opens a line link on the window that starts there, without reading the prefix", async () => {
    const h = harness({ live: false, at: 700_000 });
    h.queue(chunkAt("the linked line\nnext\n", 700_000, { complete: true }));
    h.reader.open();
    await h.settle();
    expect(h.reads).toEqual([{ from: { _tag: "offset", offset: 700_000 }, refresh: "user" }]);
    // The window starts on a line, so its first line shows.
    expect([...h.layouts.at(-1)!.rows]).toEqual([0, 1]);
    expect(h.reader.canLoadEarlier()).toBe(true);
  });

  it("loads earlier text before the loaded start and keeps the phase", async () => {
    const h = harness({ live: false });
    h.queue(chunkAt("partial\nlast\n", 8, { complete: true }));
    h.reader.open();
    await h.settle();
    h.queue(chunkAt("earlier", 0, { firstLine: 0 }));
    h.reader.loadEarlier();
    await h.settle();
    expect(h.reads.at(-1)).toEqual({ from: { _tag: "before", offset: 8 }, refresh: "user" });
    // Earlier text says nothing about the end: the log is still complete.
    expect(h.state).toMatchObject({ phase: "done", complete: true, range: { start: 0, end: 21 } });
    expect(h.reader.canLoadEarlier()).toBe(false);
  });

  it("offers earlier text of a downloaded log whose head the server dropped", async () => {
    const h = harness({ live: false });
    // The server keeps the last 16 MiB; every window it serves says `truncatedHead`.
    h.queue(chunkAt("tail\n", 20_000_000, { complete: true, truncatedHead: true }));
    h.reader.open();
    await h.settle();
    expect(h.reader.canLoadEarlier()).toBe(true);
    h.queue(chunkAt("middle\n", 19_999_993, { truncatedHead: true }));
    h.reader.loadEarlier();
    await h.settle();
    expect(h.state.range).toEqual({ start: 19_999_993, end: 20_000_005 });
    // The kept head is reached: a window with nothing earlier ends Load earlier.
    h.queue(chunkAt("", 19_999_993, { truncatedHead: true }));
    h.reader.loadEarlier();
    await h.settle();
    expect(h.state.earlierLimit).toBe("start");
    expect(h.reader.canLoadEarlier()).toBe(false);
  });

  it("stops Load earlier at the view's 16 MiB", async () => {
    const h = harness({ live: false });
    const line = `${"y".repeat(1023)}\n`;
    const big = line.repeat(16 * 1024);
    h.queue(chunkAt(big, 30_000_000, { complete: true }));
    h.reader.open();
    await h.settle();
    expect(h.state.earlierLimit).toBe("cap");
    expect(h.reader.canLoadEarlier()).toBe(false);
  });

  it("keeps following after a failed Load earlier, and retries it", async () => {
    const h = harness({ live: true });
    h.queue(chunkAt("b\n", 10));
    h.reader.open();
    await h.settle();
    h.fail(
      new PullRequestsOperationError({
        operation: "pipelines.getJobLog",
        code: "timeout",
        message: "GitLab didn't answer in time.",
        hostDetail: null,
        retryable: true,
      }),
    );
    h.reader.loadEarlier();
    await h.settle();
    expect(h.state).toMatchObject({
      phase: "following",
      errorMessage: "GitLab didn't answer in time.",
    });
    h.queue(chunkAt("a\n", 8));
    h.reader.retry();
    await h.settle();
    expect(h.reads.at(-1)).toEqual({ from: { _tag: "before", offset: 10 }, refresh: "user" });
    expect(h.state).toMatchObject({
      phase: "following",
      errorMessage: null,
      range: { start: 8, end: 12 },
    });
  });

  it("stays on a failure until it is retried, then sends the same read", async () => {
    const h = harness({ live: false });
    const limited = new PullRequestsOperationError({
      operation: "pipelines.getJobLog",
      code: "rate_limited",
      message: "GitLab's rate limit was reached.",
      hostDetail: null,
      retryable: true,
      retryAfterSeconds: 60,
    });
    h.fail(limited);
    h.reader.open();
    await h.settle();
    expect(h.state).toMatchObject({ phase: "failed", error: limited });
    h.queue(chunkAt("ok\n", 0, { complete: true }));
    h.reader.retry();
    await h.settle();
    expect(h.reads).toHaveLength(2);
    expect(h.reads[1]).toEqual(h.reads[0]);
    expect(h.state.phase).toBe("done");
  });

  it("shows why a log is unavailable and clears any loaded text", async () => {
    const h = harness({ live: false });
    h.queue({ _tag: "unavailable", reason: "erased", url: null });
    h.reader.open();
    await h.settle();
    expect(h.state).toMatchObject({ phase: "unavailable", unavailable: { reason: "erased" } });
  });

  it("follows 5 s after each read while the page is visible, and not while hidden", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness({ live: true });
    let offset = 0;
    const next = () => {
      const log = chunkAt(`at ${offset}\n`, offset);
      offset = log._tag === "chunk" ? log.nextOffset : offset;
      return log;
    };
    h.queue(next());
    h.reader.open();
    await h.settle();
    for (let step = 0; step < 6; step += 1) {
      h.queue(next());
      await vi.advanceTimersByTimeAsync(5_000);
      await h.settle();
    }
    expect(h.reads).toHaveLength(7);
    h.reader.setVisible(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.reads).toHaveLength(7);
    h.queue(next());
    h.reader.setVisible(true);
    await vi.advanceTimersByTimeAsync(5_000);
    await h.settle();
    expect(h.reads).toHaveLength(8);
    h.reader.setLive(false);
    await h.settle();
    const final = h.reads.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.reads).toHaveLength(final);
  });

  it("reads a finished log past a line link's window only when its end is reached", async () => {
    const h = harness({ live: false, at: 600_000 });
    h.queue(fullWindow(600_000));
    h.reader.open();
    await h.settle();
    // One window, however full: a finished log does not catch up.
    expect(h.reads).toHaveLength(1);
    expect(h.state.phase).toBe("done");
    expect(h.reader.canLoadLater()).toBe(true);
    h.queue(chunkAt("the end\n", 600_000 + WINDOW, { complete: true }));
    h.reader.loadLater();
    await h.settle();
    expect(h.reads.at(-1)).toEqual({
      from: { _tag: "offset", offset: 600_000 + WINDOW },
      refresh: "user",
    });
    expect(h.state).toMatchObject({ phase: "done", complete: true });
    expect(h.reader.canLoadLater()).toBe(false);
  });

  it("stops reading later text at the page's 16 MiB cap", async () => {
    const h = harness({ live: false, at: 600_000 });
    // A window whose offsets already span the cap (its text is short).
    h.queue(chunkAt("x\n", 600_000, { nextOffset: 600_000 + LOG_CLIENT_CAP }));
    h.reader.open();
    await h.settle();
    expect(h.state.phase).toBe("done");
    expect(h.reader.canLoadLater()).toBe(false);
    h.reader.loadLater();
    expect(h.reads).toHaveLength(1);
  });

  it("reads the rest of a log that finished while an earlier read was out", async () => {
    const h = harness({ live: true, at: null });
    h.queue(chunkAt("x\n".repeat(10), 100_000));
    h.reader.open();
    await h.settle();
    expect(h.state.phase).toBe("following");
    h.reader.loadEarlier();
    h.reader.setLive(false);
    h.answer(chunkAt("earlier\n", 99_992));
    await h.settle();
    expect(h.reads.at(-1)).toEqual({ from: { _tag: "offset", offset: 100_020 }, refresh: "user" });
    h.answer(chunkAt("the end\n", 100_020, { complete: true }));
    await h.settle();
    expect(h.state).toMatchObject({ phase: "done", complete: true });
  });

  it("stops reading later text when the host has none", async () => {
    const h = harness({ live: false });
    h.queue(chunkAt("cached while running\n", 0, { complete: false }));
    h.reader.open();
    await h.settle();
    h.queue(chunkAt("", 21, { complete: false }));
    h.reader.loadLater();
    await h.settle();
    expect(h.state.laterExhausted).toBe(true);
    expect(h.reader.canLoadLater()).toBe(false);
  });
});
