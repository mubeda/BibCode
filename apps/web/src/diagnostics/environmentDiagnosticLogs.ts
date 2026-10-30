import {
  DiagnosticLogsDownloadError,
  diagnosticLogsError,
  downloadDiagnosticLogs,
  type DownloadedDiagnosticLogs,
} from "@bibcode/client-runtime/diagnostics";
import { runInEnvironment } from "@bibcode/client-runtime/state/runtime";
import type { EnvironmentSupervisor } from "@bibcode/client-runtime/connection";
import type { DiagnosticLogsDownloadInput, EnvironmentId } from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import type * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

/** Why a run in an environment was stopped by its caller. */
export class EnvironmentRunAborted extends Error {
  constructor() {
    super("Stopped.");
    this.name = "EnvironmentRunAborted";
  }
}

/**
 * Runs `effect` on `environmentId`'s connection and settles with its outcome. Aborting
 * `signal` interrupts it (a stream it runs ends on the server too) and rejects with
 * {@link EnvironmentRunAborted}. `mapFailure` turns a typed failure or defect into the error
 * the promise rejects with.
 */
export function runInEnvironmentAsPromise<A, E>(
  environmentId: EnvironmentId,
  effect: Effect.Effect<A, E, EnvironmentSupervisor>,
  mapFailure: (failure: unknown) => unknown,
  signal?: AbortSignal,
): Promise<A> {
  if (signal?.aborted === true) return Promise.reject(new EnvironmentRunAborted());
  const atom = connectionAtomRuntime.atom(runInEnvironment(environmentId, effect));
  return new Promise<A>((resolve, reject) => {
    let settled = false;
    let unmount: () => void = () => {};
    let unsubscribe: () => void = () => {};
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      unmount();
      finish();
    };
    const onAbort = () => settle(() => reject(new EnvironmentRunAborted()));
    signal?.addEventListener("abort", onAbort);
    unmount = appAtomRegistry.mount(atom);
    const stop = appAtomRegistry.subscribe(
      atom,
      (emission) => {
        if (emission._tag === "Success" && !emission.waiting) {
          settle(() => resolve(emission.value));
        } else if (emission._tag === "Failure" && !emission.waiting) {
          const failure = Cause.squash(emission.cause);
          settle(() => reject(mapFailure(failure)));
        }
      },
      { immediate: true },
    );
    // An immediate emission may have settled before `subscribe` returned.
    if (settled) stop();
    else unsubscribe = stop;
  });
}

/**
 * Downloads `environmentId`'s diagnostic bundle over that environment's own RPC connection.
 * Every failure is a `DiagnosticLogsDownloadError` naming `label`: one the download itself
 * raised, "not connected" when the environment is not registered, and "connection lost"
 * for anything that ended it from outside (the socket closing, the session being replaced).
 * Aborting `signal` stops it, which also stops the environment's stream.
 */
export function downloadEnvironmentDiagnosticLogs(
  environmentId: EnvironmentId,
  label: string,
  input: DiagnosticLogsDownloadInput,
  signal?: AbortSignal,
): Promise<DownloadedDiagnosticLogs> {
  return runInEnvironmentAsPromise(
    environmentId,
    downloadDiagnosticLogs(input),
    (failure) =>
      failure instanceof DiagnosticLogsDownloadError
        ? failure
        : isNotRegistered(failure)
          ? diagnosticLogsError("not-connected", label)
          : diagnosticLogsError("connection-lost", label),
    signal,
  );
}

function isNotRegistered(failure: unknown): boolean {
  return (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    failure._tag === "EnvironmentNotRegisteredError"
  );
}
