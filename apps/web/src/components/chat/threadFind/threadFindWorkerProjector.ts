/* oxlint-disable unicorn/require-post-message-target-origin -- Worker messages have no target origin. */
/**
 * The projector Find in thread uses in the app: small entries are projected on the main thread
 * between scan slices, and an entry above `WORKER_PROJECTION_MIN_LENGTH` in a worker, so one
 * large reply never stalls input.
 */
import type { FindProjector } from "./threadFindIndex";
import {
  projectFindSource,
  type FindProjectionContext,
  type FindSegment,
  type FindSource,
} from "./threadFindText";

/**
 * Measured at about 1.2 ms per KB of chat Markdown (vitest on an Apple-silicon Mac, 1.9 MB over
 * 3,000 messages and a single 1 MB reply), so 16 KB stays well under a 50 ms stall on slower
 * engines.
 */
export const WORKER_PROJECTION_MIN_LENGTH = 16 * 1024;

export interface FindProjectionRequest {
  readonly id: number;
  readonly source: FindSource;
  readonly context: FindProjectionContext;
}

export interface FindProjectionResponse {
  readonly id: number;
  /** Null when the worker could not project; the main thread then projects it itself. */
  readonly segments: FindSegment[] | null;
}

interface ProjectionWorker {
  postMessage(message: FindProjectionRequest): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<FindProjectionResponse>) => void,
  ): void;
  addEventListener(type: "error", listener: () => void): void;
  terminate(): void;
}

function createProjectionWorker(): ProjectionWorker {
  return new Worker(new URL("./threadFindProjection.worker.ts", import.meta.url), {
    type: "module",
    name: "thread-find-projection",
  }) as unknown as ProjectionWorker;
}

interface PendingProjection {
  readonly source: FindSource;
  readonly context: FindProjectionContext;
  readonly resolve: (segments: FindSegment[]) => void;
}

export function createWorkerFindProjector(
  createWorker: () => ProjectionWorker = createProjectionWorker,
): FindProjector {
  let worker: ProjectionWorker | null = null;
  let workerFailed = false;
  let nextId = 0;
  const pending = new Map<number, PendingProjection>();

  const settleOnMainThread = () => {
    workerFailed = true;
    worker?.terminate();
    worker = null;
    for (const [id, request] of pending) {
      pending.delete(id);
      request.resolve(projectFindSource(request.source, request.context));
    }
  };

  const startWorker = (): ProjectionWorker | null => {
    if (worker || workerFailed) return worker;
    try {
      worker = createWorker();
    } catch {
      workerFailed = true;
      return null;
    }
    worker.addEventListener("message", (event) => {
      const request = pending.get(event.data.id);
      if (!request) return;
      pending.delete(event.data.id);
      request.resolve(event.data.segments ?? projectFindSource(request.source, request.context));
    });
    worker.addEventListener("error", settleOnMainThread);
    return worker;
  };

  return {
    project(source, context) {
      if (source.text.length < WORKER_PROJECTION_MIN_LENGTH) {
        return projectFindSource(source, context);
      }
      const target = startWorker();
      if (!target) {
        return projectFindSource(source, context);
      }
      const id = nextId;
      nextId += 1;
      return new Promise<FindSegment[]>((resolve) => {
        pending.set(id, { source, context, resolve });
        target.postMessage({ id, source, context });
      });
    },
    dispose() {
      worker?.terminate();
      worker = null;
      // Nothing waits on these once the timeline is gone.
      pending.clear();
    },
  };
}
