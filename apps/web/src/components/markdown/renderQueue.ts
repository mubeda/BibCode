interface RenderJob<T> {
  readonly run: () => T;
  readonly done: (value: T) => void;
  readonly fail: ((error: unknown) => void) | undefined;
}

/** Waiting jobs, the most recently scheduled last. */
const renderQueue: RenderJob<unknown>[] = [];
let renderPumpScheduled = false;

/**
 * Runs one waiting render job per task, the most recently scheduled first, so a block the user
 * scrolled to is rendered before the ones scrolled past and input runs between blocks (#103).
 * Code highlights and Mermaid diagrams share it. A job that throws goes to `fail`, or is dropped
 * when there is none. Returns a cancel that drops the job if it has not run.
 */
export function scheduleRender<T>(
  run: () => T,
  done: (value: T) => void,
  fail?: (error: unknown) => void,
): () => void {
  const job: RenderJob<T> = { run, done, fail };
  renderQueue.push(job as RenderJob<unknown>);
  if (!renderPumpScheduled) {
    renderPumpScheduled = true;
    setTimeout(pumpRenders, 0);
  }
  let cancelled = false;
  return () => {
    if (cancelled) return;
    cancelled = true;
    const index = renderQueue.indexOf(job as RenderJob<unknown>);
    if (index >= 0) renderQueue.splice(index, 1);
  };
}

function runJob(job: RenderJob<unknown>): void {
  let value: unknown;
  try {
    value = job.run();
  } catch (error) {
    job.fail?.(error);
    return;
  }
  job.done(value);
}

function pumpRenders(): void {
  const job = renderQueue.pop();
  if (job) {
    try {
      runJob(job);
    } catch {
      // A failing callback must not stall the queue; the block keeps what it shows.
    }
  }
  if (renderQueue.length > 0) {
    setTimeout(pumpRenders, 0);
  } else {
    renderPumpScheduled = false;
  }
}
