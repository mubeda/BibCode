import { describe, expect, it, vi } from "vite-plus/test";
import type { FindSource } from "./threadFindText";
import {
  createWorkerFindProjector,
  WORKER_PROJECTION_MIN_LENGTH,
  type FindProjectionRequest,
  type FindProjectionResponse,
} from "./threadFindWorkerProjector";

function fakeWorker() {
  const listeners: {
    message: Array<(event: MessageEvent<FindProjectionResponse>) => void>;
    error: Array<() => void>;
  } = { message: [], error: [] };
  const posted: FindProjectionRequest[] = [];
  return {
    posted,
    terminate: vi.fn(),
    postMessage(message: FindProjectionRequest) {
      posted.push(message);
    },
    addEventListener(type: "message" | "error", listener: never) {
      listeners[type].push(listener);
    },
    reply(response: FindProjectionResponse) {
      for (const listener of listeners.message) {
        listener({ data: response } as MessageEvent<FindProjectionResponse>);
      }
    },
    fail() {
      for (const listener of listeners.error) listener();
    },
  };
}

const source = (text: string): FindSource => ({
  kind: "markdown",
  scope: "md:0",
  text,
  lineBreaks: false,
  skills: [],
});
const CONTEXT = { cwd: undefined };
const LARGE = `large ${"x".repeat(WORKER_PROJECTION_MIN_LENGTH)}`;

describe("createWorkerFindProjector", () => {
  it("projects a small entry on the main thread without starting a worker", () => {
    const createWorker = vi.fn(fakeWorker);
    const projector = createWorkerFindProjector(createWorker);
    const segments = projector.project(source("small text"), CONTEXT);
    expect(Array.isArray(segments)).toBe(true);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("sends a large entry's text, never a query, to the worker", async () => {
    const worker = fakeWorker();
    const projector = createWorkerFindProjector(() => worker);
    const pending = projector.project(source(LARGE), CONTEXT);
    expect(pending).toBeInstanceOf(Promise);
    expect(Object.keys(worker.posted[0]!).toSorted()).toEqual(["context", "id", "source"]);
    worker.reply({ id: worker.posted[0]!.id, segments: [] });
    expect(await pending).toEqual([]);
    projector.dispose?.();
    expect(worker.terminate).toHaveBeenCalled();
  });

  it("projects on the main thread when the worker fails", async () => {
    const worker = fakeWorker();
    const projector = createWorkerFindProjector(() => worker);
    const pending = projector.project(source(LARGE), CONTEXT);
    worker.fail();
    const segments = await pending;
    expect(segments.length).toBeGreaterThan(0);
    // Later large entries no longer try the worker.
    expect(Array.isArray(projector.project(source(LARGE), CONTEXT))).toBe(true);
  });

  it("projects on the main thread when no worker can start", () => {
    const projector = createWorkerFindProjector(() => {
      throw new Error("Worker is not supported");
    });
    expect(Array.isArray(projector.project(source(LARGE), CONTEXT))).toBe(true);
  });
});
