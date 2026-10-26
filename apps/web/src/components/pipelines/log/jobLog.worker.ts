/* oxlint-disable unicorn/require-post-message-target-origin -- Worker messages have no target origin. */
// Parses a job's log off the main thread. It receives the log text the view read and
// answers layouts, the spans of visible lines and search results; it never sees the
// network or the page.
import { JobLogModel } from "./jobLog.parse";
import {
  answerJobLogRequest,
  layoutTransfer,
  type JobLogRequest,
  type JobLogResponse,
} from "./jobLogEngine";

/** The dedicated worker scope; the app's DOM lib types `self` as a window. */
interface WorkerScope {
  postMessage(message: JobLogResponse, transfer: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<JobLogRequest>) => void): void;
}

const scope = self as unknown as WorkerScope;
const model = new JobLogModel();

scope.addEventListener("message", (event) => {
  const { id } = event.data;
  try {
    const result = answerJobLogRequest(model, event.data);
    scope.postMessage({ id, result }, layoutTransfer(result));
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : "parse failed" }, []);
  }
});
