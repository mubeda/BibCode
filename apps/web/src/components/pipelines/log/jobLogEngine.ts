/* oxlint-disable unicorn/require-post-message-target-origin -- Worker messages have no target origin. */
/**
 * Where the job log parser runs. The app parses in a worker, so a 100,000-line log
 * never blocks input; when no worker can start, the same parser runs on the main
 * thread in 64 KiB slices between frames, as Find in thread does. Both engines answer
 * the same asynchronous interface, in the order requests were made.
 */
import {
  JobLogModel,
  utf8Length,
  type JobLogLayout,
  type LogChunkInput,
  type LogSpans,
  type LogStyle,
} from "./jobLog.parse";

export interface JobLogRendered {
  readonly spans: ReadonlyMap<number, LogSpans>;
  readonly styles: readonly LogStyle[];
}

export interface JobLogSearchResult {
  readonly matches: Int32Array;
  readonly capped: boolean;
}

export interface JobLogEngine {
  load(chunk: LogChunkInput): Promise<JobLogLayout>;
  reset(): Promise<void>;
  setCollapsed(sectionId: number, collapsed: boolean): Promise<JobLogLayout>;
  setAllCollapsed(collapsed: boolean): Promise<JobLogLayout>;
  /** Expands the sections hiding a raw line. */
  reveal(index: number): Promise<JobLogLayout>;
  render(indices: readonly number[]): Promise<JobLogRendered>;
  search(query: string): Promise<JobLogSearchResult>;
  dispose(): void;
}

type Operation =
  | { readonly op: "load"; readonly chunk: LogChunkInput }
  | { readonly op: "reset" }
  | { readonly op: "setCollapsed"; readonly sectionId: number; readonly collapsed: boolean }
  | { readonly op: "setAllCollapsed"; readonly collapsed: boolean }
  | { readonly op: "reveal"; readonly index: number }
  | { readonly op: "render"; readonly indices: readonly number[] }
  | { readonly op: "search"; readonly query: string };

export type JobLogRequest = Operation & { readonly id: number };

export interface JobLogResponse {
  readonly id: number;
  readonly result?: unknown;
  readonly error?: string;
}

/** Runs one request against a model; the worker and the tests share it. */
export function answerJobLogRequest(model: JobLogModel, request: Operation): unknown {
  switch (request.op) {
    case "load":
      model.load(request.chunk);
      return model.layout();
    case "reset":
      model.reset();
      return null;
    case "setCollapsed":
      model.setCollapsed(request.sectionId, request.collapsed);
      return model.layout();
    case "setAllCollapsed":
      model.setAllCollapsed(request.collapsed);
      return model.layout();
    case "reveal":
      model.reveal(request.index);
      return model.layout();
    case "render":
      return { spans: model.render(request.indices), styles: model.styleTable };
    case "search":
      return model.search(request.query);
  }
}

/** The typed arrays a layout carries, to transfer instead of copy. */
export function layoutTransfer(result: unknown): Transferable[] {
  if (result === null || typeof result !== "object" || !("rows" in result)) return [];
  const layout = result as JobLogLayout;
  return [
    layout.rows.buffer,
    layout.byteStarts.buffer,
    layout.timestamps.buffer,
    layout.kinds.buffer,
    layout.sectionOf.buffer,
  ] as Transferable[];
}

export const MAIN_THREAD_SLICE = 64 * 1024;

const nextFrame = () =>
  new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });

/** Cuts `text` into slices of at most `size` code units, never inside a surrogate pair. */
export function sliceText(text: string, size = MAIN_THREAD_SLICE): string[] {
  const slices: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    const code = text.charCodeAt(end);
    if (end < text.length && code >= 0xdc00 && code <= 0xdfff) end -= 1;
    slices.push(text.slice(start, end));
    start = end;
  }
  return slices;
}

function newlines(text: string): number {
  let count = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1))
    count += 1;
  return count;
}

/**
 * The parser on the main thread. A chunk larger than one slice is fed a slice per
 * frame; earlier text re-feeds the whole range from its new start the same way,
 * because styles and sections flow forward.
 */
export function createMainThreadJobLogEngine(
  yieldToFrame: () => Promise<void> = nextFrame,
): JobLogEngine {
  const model = new JobLogModel();
  let queue: Promise<unknown> = Promise.resolve();
  let disposed = false;
  const enqueue = <T>(run: () => Promise<T> | T): Promise<T> => {
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  };
  /** Feeds `chunk` as later text, or, with `fresh`, as the whole log. */
  const feed = async (chunk: LogChunkInput, fresh: boolean) => {
    const slices = sliceText(chunk.text);
    if (slices.length === 0) slices.push("");
    let offset = chunk.offset;
    for (const [index, text] of slices.entries()) {
      if (disposed) return;
      const first = index === 0;
      const nextOffset = index === slices.length - 1 ? chunk.nextOffset : offset + utf8Length(text);
      if (first && fresh) model.reset();
      model.load({
        text,
        offset,
        nextOffset,
        firstLine: first ? chunk.firstLine : null,
        startsAtLine: first ? chunk.startsAtLine : false,
      });
      offset = nextOffset;
      if (index < slices.length - 1) await yieldToFrame();
    }
  };
  return {
    load: (chunk) =>
      enqueue(async () => {
        const { start, end } = model.range;
        if (model.isLoaded && chunk.offset === end) await feed(chunk, false);
        else if (model.isLoaded && chunk.nextOffset === start) {
          const known = model.knownFirstLine;
          await feed(
            {
              text: chunk.text + model.rawText(),
              offset: chunk.offset,
              nextOffset: end,
              firstLine: chunk.firstLine ?? (known === null ? null : known - newlines(chunk.text)),
              startsAtLine: chunk.startsAtLine || chunk.offset === 0,
            },
            true,
          );
        } else await feed(chunk, true);
        return model.layout();
      }),
    reset: () => enqueue(() => model.reset()),
    setCollapsed: (sectionId, collapsed) =>
      enqueue(() => {
        model.setCollapsed(sectionId, collapsed);
        return model.layout();
      }),
    setAllCollapsed: (collapsed) =>
      enqueue(() => {
        model.setAllCollapsed(collapsed);
        return model.layout();
      }),
    reveal: (index) =>
      enqueue(() => {
        model.reveal(index);
        return model.layout();
      }),
    render: (indices) =>
      enqueue(() => ({ spans: model.render(indices), styles: model.styleTable })),
    search: (query) => enqueue(() => model.search(query)),
    dispose: () => {
      disposed = true;
    },
  };
}

export interface JobLogWorkerLike {
  postMessage(message: JobLogRequest): void;
  addEventListener(type: "message", listener: (event: MessageEvent<JobLogResponse>) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  terminate(): void;
}

function createJobLogWorker(): JobLogWorkerLike {
  return new Worker(new URL("./jobLog.worker.ts", import.meta.url), {
    type: "module",
    name: "job-log",
  }) as unknown as JobLogWorkerLike;
}

/** A worker that stopped answering; the log is read again on the main thread. */
export class JobLogWorkerLost extends Error {
  constructor() {
    super("The log worker stopped.");
  }
}

/**
 * The parser in a worker, or on the main thread when no worker can start. A worker
 * that fails rejects what was waiting on it with `JobLogWorkerLost` and calls
 * `onLost`; later requests run on the main thread, which starts empty, so the caller
 * reads the log again. The engine keeps no copy of the text it sent.
 */
export function createJobLogEngine({
  createWorker = typeof Worker === "function" ? createJobLogWorker : null,
  onLost,
}: {
  createWorker?: (() => JobLogWorkerLike) | null;
  onLost?: () => void;
} = {}): JobLogEngine {
  let worker: JobLogWorkerLike | null = null;
  let fallback: JobLogEngine | null = null;
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  const lose = () => {
    if (worker === null) return;
    worker.terminate();
    worker = null;
    fallback = createMainThreadJobLogEngine();
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.reject(new JobLogWorkerLost());
    }
    onLost?.();
  };

  if (createWorker !== null) {
    try {
      const started = createWorker();
      worker = started;
      started.addEventListener("message", (event) => {
        const entry = pending.get(event.data.id);
        if (!entry) return;
        pending.delete(event.data.id);
        if (event.data.error !== undefined) entry.reject(new Error(event.data.error));
        else entry.resolve(event.data.result);
      });
      started.addEventListener("error", lose);
    } catch {
      worker = null;
    }
  }
  if (worker === null) fallback = createMainThreadJobLogEngine();

  const request = <T>(operation: Operation): Promise<T> => {
    const target = worker;
    if (target === null) return runOn(fallback!, operation) as Promise<T>;
    const id = nextId;
    nextId += 1;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      target.postMessage({ ...operation, id });
    });
  };

  return {
    load: (chunk) => request({ op: "load", chunk }),
    reset: () => request({ op: "reset" }),
    setCollapsed: (sectionId, collapsed) => request({ op: "setCollapsed", sectionId, collapsed }),
    setAllCollapsed: (collapsed) => request({ op: "setAllCollapsed", collapsed }),
    reveal: (index) => request({ op: "reveal", index }),
    render: (indices) => request({ op: "render", indices }),
    search: (query) => request({ op: "search", query }),
    dispose: () => {
      worker?.terminate();
      worker = null;
      fallback?.dispose();
      // Nothing waits on these once the view is gone.
      pending.clear();
    },
  };
}

function runOn(engine: JobLogEngine, operation: Operation): Promise<unknown> {
  switch (operation.op) {
    case "load":
      return engine.load(operation.chunk);
    case "reset":
      return engine.reset();
    case "setCollapsed":
      return engine.setCollapsed(operation.sectionId, operation.collapsed);
    case "setAllCollapsed":
      return engine.setAllCollapsed(operation.collapsed);
    case "reveal":
      return engine.reveal(operation.index);
    case "render":
      return engine.render(operation.indices);
    case "search":
      return engine.search(operation.query);
  }
}
