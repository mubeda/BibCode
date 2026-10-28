import {
  DiagnosticLogsDownloadError,
  diagnosticLogsError,
  downloadDiagnosticLogs,
  type DownloadedDiagnosticLogs,
} from "@bibcode/client-runtime/diagnostics";
import { runInEnvironment } from "@bibcode/client-runtime/state/runtime";
import type { DiagnosticLogsDownloadInput, EnvironmentId } from "@bibcode/contracts";
import * as Cause from "effect/Cause";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

/**
 * Downloads `environmentId`'s diagnostic bundle over that environment's own RPC connection.
 * Every failure is a `DiagnosticLogsDownloadError` naming `label`: one the download itself
 * raised, "not connected" when the environment is not registered, and "connection lost"
 * for anything that ended it from outside (the socket closing, the session being replaced).
 */
export function downloadEnvironmentDiagnosticLogs(
  environmentId: EnvironmentId,
  label: string,
  input: DiagnosticLogsDownloadInput,
): Promise<DownloadedDiagnosticLogs> {
  const atom = connectionAtomRuntime.atom(
    runInEnvironment(environmentId, downloadDiagnosticLogs(input)),
  );
  return new Promise<DownloadedDiagnosticLogs>((resolve, reject) => {
    let settled = false;
    let unmount: () => void = () => {};
    let unsubscribe: () => void = () => {};
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      unmount();
      finish();
    };
    unmount = appAtomRegistry.mount(atom);
    const stop = appAtomRegistry.subscribe(
      atom,
      (emission) => {
        if (emission._tag === "Success" && !emission.waiting) {
          settle(() => resolve(emission.value));
        } else if (emission._tag === "Failure" && !emission.waiting) {
          const failure = Cause.squash(emission.cause);
          settle(() =>
            reject(
              failure instanceof DiagnosticLogsDownloadError
                ? failure
                : isNotRegistered(failure)
                  ? diagnosticLogsError("not-connected", label)
                  : diagnosticLogsError("connection-lost", label),
            ),
          );
        }
      },
      { immediate: true },
    );
    // An immediate emission may have settled before `subscribe` returned.
    if (settled) stop();
    else unsubscribe = stop;
  });
}

function isNotRegistered(failure: unknown): boolean {
  return (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    failure._tag === "EnvironmentNotRegisteredError"
  );
}
