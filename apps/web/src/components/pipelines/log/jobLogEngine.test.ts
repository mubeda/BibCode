import { describe, expect, it, vi } from "vite-plus/test";
import { JobLogModel, utf8Length, type LogChunkInput } from "./jobLog.parse";
import {
  JobLogWorkerLost,
  MAIN_THREAD_SLICE,
  answerJobLogRequest,
  createJobLogEngine,
  createMainThreadJobLogEngine,
  sliceText,
  type JobLogRequest,
  type JobLogResponse,
  type JobLogWorkerLike,
} from "./jobLogEngine";

function chunk(text: string, offset = 0, firstLine: number | null = 0): LogChunkInput {
  return { text, offset, nextOffset: offset + utf8Length(text), firstLine, startsAtLine: false };
}

/** A worker that answers on a later turn, as a real one does, until it is told to fail. */
function fakeWorker() {
  const model = new JobLogModel();
  const listeners = {
    message: [] as ((event: MessageEvent<JobLogResponse>) => void)[],
    error: [] as (() => void)[],
  };
  const posted: JobLogRequest[] = [];
  let silent = false;
  const worker: JobLogWorkerLike = {
    postMessage(message) {
      posted.push(message);
      if (silent) return;
      queueMicrotask(() => {
        const result = answerJobLogRequest(model, message);
        for (const listener of listeners.message)
          listener({ data: { id: message.id, result } } as MessageEvent<JobLogResponse>);
      });
    },
    addEventListener(type: "message" | "error", listener: never) {
      listeners[type].push(listener);
    },
    terminate: vi.fn(),
  };
  return {
    worker,
    posted,
    hang: () => {
      silent = true;
    },
    fail: () => {
      for (const listener of listeners.error) listener();
    },
  };
}

describe("job log engine", () => {
  it("parses in the worker and answers layouts, spans and searches", async () => {
    const fake = fakeWorker();
    const engine = createJobLogEngine({ createWorker: () => fake.worker });
    const layout = await engine.load(chunk("\u001b[31mred\u001b[0m\nplain\n"));
    expect([...layout.rows]).toEqual([0, 1]);
    const rendered = await engine.render([0]);
    expect(rendered.spans.get(0)).toEqual([["red", 1]]);
    expect(rendered.styles[1]).toEqual({ fg: 1, bg: -1, flags: 0 });
    expect([...(await engine.search("PLAIN")).matches]).toEqual([1]);
    expect(fake.posted.map((request) => request.op)).toEqual(["load", "render", "search"]);
  });

  it("falls back to the main thread when the worker cannot start", async () => {
    const engine = createJobLogEngine({
      createWorker: () => {
        throw new Error("blocked");
      },
    });
    const layout = await engine.load(chunk("one\ntwo\n"));
    expect(layout.lineCount).toBe(2);
  });

  it("rejects what waited on a failed worker and reads on the main thread afterwards", async () => {
    const fake = fakeWorker();
    const onLost = vi.fn();
    const engine = createJobLogEngine({ createWorker: () => fake.worker, onLost });
    fake.hang();
    const waiting = engine.load(chunk("lost\n"));
    fake.fail();
    await expect(waiting).rejects.toBeInstanceOf(JobLogWorkerLost);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(fake.worker.terminate).toHaveBeenCalled();
    const layout = await engine.load(chunk("again\n"));
    expect(layout.lineCount).toBe(1);
  });

  it("feeds a large chunk on the main thread one 64 KiB slice per frame", async () => {
    const frames = vi.fn(() => Promise.resolve());
    const engine = createMainThreadJobLogEngine(frames);
    const text = "x".repeat(99) + "\n";
    const big = text.repeat(Math.ceil((MAIN_THREAD_SLICE * 2.5) / text.length));
    const layout = await engine.load(chunk(big));
    expect(frames).toHaveBeenCalledTimes(Math.ceil(big.length / MAIN_THREAD_SLICE) - 1);
    expect(layout.lineCount).toBe(big.length / text.length);
    expect(layout.endOffset).toBe(utf8Length(big));
  });

  it("re-feeds the whole range when earlier text arrives, as the worker parses it", async () => {
    const head = `${"\u001b[32m"}${"head ".repeat(20_000)}\n`;
    const tail = "tail line\n";
    const engine = createMainThreadJobLogEngine(() => Promise.resolve());
    await engine.load(chunk(tail, utf8Length(head), null));
    const layout = await engine.load(chunk(head, 0, 0));
    const reference = new JobLogModel();
    reference.load(chunk(head + tail));
    expect([...layout.rows]).toEqual([...reference.layout().rows]);
    expect(layout.firstLine).toBe(0);
    const rendered = await engine.render([1]);
    // The green set at the head carries into the tail.
    expect(rendered.styles[rendered.spans.get(1)![0]![1]]).toEqual({ fg: 2, bg: -1, flags: 0 });
  });

  it("never cuts a slice inside a surrogate pair", () => {
    const text = `${"a".repeat(MAIN_THREAD_SLICE - 1)}😀b`;
    const slices = sliceText(text);
    expect(slices.join("")).toBe(text);
    expect(slices.map(utf8Length).reduce((a, b) => a + b, 0)).toBe(utf8Length(text));
  });
});
