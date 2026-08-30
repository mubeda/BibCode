import { type EnvironmentId, type RemoteUpdateSnapshot, WS_METHODS } from "@bibcode/contracts";
import type { Atom } from "effect/unstable/reactivity";

import {
  type AtomCommandResult,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { type EnvironmentRpcInput, request } from "../rpc/client.ts";

/** Spec section 4.5: "Check for Server Updates" fans out with max 2 concurrent. */
export const MAX_CONCURRENT_REMOTE_UPDATE_CHECKS = 2;
export const REMOTE_UPDATE_CHECK_TIMEOUT_MS = 30_000;

export interface RemoteUpdateFanOutResult<A, E> {
  readonly environmentId: EnvironmentId;
  readonly outcome:
    | { readonly kind: "success"; readonly result: AtomCommandResult<A, E> }
    | {
        readonly kind: "failure";
        /** The settled Failure result, or null when the dispatcher itself threw. */
        readonly result: AtomCommandResult<A, E> | null;
        readonly error: unknown;
      };
}

/**
 * Runs `check` for every environment with bounded concurrency. One environment's
 * failure never aborts the batch; results keep input order.
 *
 * IMPORTANT: `check` is expected to resolve with a SETTLED `AtomCommandResult`
 * (`useAtomCommand`/`runAtomCommand` semantics — typed failures are values with
 * `_tag: "Failure"`, they do not reject). Classification therefore inspects the
 * settled result's tag; the catch branch is only a defensive net for a
 * dispatcher that throws outright.
 */
export async function fanOutRemoteUpdateChecks<A, E>(
  environmentIds: ReadonlyArray<EnvironmentId>,
  check: (environmentId: EnvironmentId) => Promise<AtomCommandResult<A, E>>,
  maxConcurrent: number = MAX_CONCURRENT_REMOTE_UPDATE_CHECKS,
): Promise<ReadonlyArray<RemoteUpdateFanOutResult<A, E>>> {
  const results: Array<RemoteUpdateFanOutResult<A, E>> = [];
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < environmentIds.length) {
      const index = nextIndex;
      nextIndex += 1;
      const environmentId = environmentIds[index]!;
      try {
        const result = await check(environmentId);
        results[index] =
          result._tag === "Success"
            ? { environmentId, outcome: { kind: "success", result } }
            : { environmentId, outcome: { kind: "failure", result, error: result } };
      } catch (error) {
        results[index] = { environmentId, outcome: { kind: "failure", result: null, error } };
      }
    }
  };
  const workerCount = Math.min(maxConcurrent, environmentIds.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

/** Feeds Phase 6's rail-dot `updateAvailable` input (spec section 4.8). */
export function isRemoteUpdateAvailable(snapshot: RemoteUpdateSnapshot | null): boolean {
  return snapshot?.state === "update-available";
}

/**
 * Per-environment update-state surface. The server owns the snapshot
 * (`updater.status` restores it after navigation/reconnect); the query atom family
 * keeps the last value per environment for instant re-render (spec section 6).
 */
export function createRemoteUpdateEnvironmentAtoms<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
) {
  return {
    snapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:remote-update:snapshot",
      tag: WS_METHODS.updaterStatus,
      staleTimeMs: 30_000,
    }),
    check: createEnvironmentCommand(runtime, {
      label: "environment-data:remote-update:check",
      timeoutMs: REMOTE_UPDATE_CHECK_TIMEOUT_MS,
      execute: (input: EnvironmentRpcInput<typeof WS_METHODS.updaterCheck>) =>
        request(WS_METHODS.updaterCheck, input),
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
    install: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:remote-update:install",
      tag: WS_METHODS.updaterInstall,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
  };
}
