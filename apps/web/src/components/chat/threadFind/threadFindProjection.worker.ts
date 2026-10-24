/* oxlint-disable unicorn/require-post-message-target-origin -- Worker messages have no target origin. */
// Projects a large entry for Find in thread off the main thread. It receives the entry's text
// and render context only; the query stays on the main thread.
import type { FindProjectionRequest, FindProjectionResponse } from "./threadFindWorkerProjector";
import { projectFindSource } from "./threadFindText";

/** The dedicated worker scope; the app's DOM lib types `self` as a window. */
interface WorkerScope {
  postMessage(message: FindProjectionResponse): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<FindProjectionRequest>) => void,
  ): void;
}

const scope = self as unknown as WorkerScope;

scope.addEventListener("message", (event) => {
  const { id, source, context } = event.data;
  try {
    scope.postMessage({ id, segments: projectFindSource(source, context) });
  } catch {
    scope.postMessage({ id, segments: null });
  }
});
