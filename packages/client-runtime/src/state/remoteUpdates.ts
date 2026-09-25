import { type EnvironmentId, type RemoteUpdateSnapshot, WS_METHODS } from "@bibcode/contracts";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { RpcClientError } from "effect/unstable/rpc";

import {
  type AtomCommandResult,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  followStreamInEnvironment,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  type EnvironmentRpcInput,
  EnvironmentRpcUnavailableError,
  request,
} from "../rpc/client.ts";

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
 * An automatic host that has not checked its feed yet. A desktop host starts every
 * launch here and runs its own first check about 15 seconds later.
 */
export function isRemoteUpdateUnchecked(snapshot: RemoteUpdateSnapshot | null): boolean {
  return snapshot?.state === "idle" && snapshot.support.installMode !== "manual";
}

const isRpcClientError = Schema.is(RpcClientError.RpcClientError);
const isEnvironmentRpcUnavailableError = Schema.is(EnvironmentRpcUnavailableError);

/**
 * True when a failed update request only lost, or never had, a live connection: every
 * reason is an interruption, a closed or broken socket (`RpcClientError`), or a missing
 * session (`EnvironmentRpcUnavailableError`, which a request meets as soon as the
 * supervisor clears its lease, before the connection phase changes). Such a failure
 * carries no news about the updater itself.
 */
export function isRemoteUpdateConnectionFailure(cause: Cause.Cause<unknown>): boolean {
  return (
    cause.reasons.length > 0 &&
    cause.reasons.every(
      (reason) =>
        reason._tag === "Interrupt" ||
        (reason._tag === "Fail" &&
          (isRpcClientError(reason.error) || isEnvironmentRpcUnavailableError(reason.error))),
    )
  );
}

/** A check that failed over a live connection, stamped with that connection's generation. */
export interface RemoteUpdateCheckFailure {
  readonly cause: Cause.Cause<unknown>;
  readonly generation: number;
}

interface RemoteUpdateConnection {
  readonly supervisor: EnvironmentSupervisor["Service"];
  readonly generation: number;
}

interface RecordedRemoteUpdateCheckFailure {
  readonly connection: RemoteUpdateConnection;
  readonly failure: RemoteUpdateCheckFailure;
}

/** Update-check progress for one environment, shared by every view of it. */
export interface RemoteUpdateCheckState {
  readonly inFlight: boolean;
  /** The latest check's failure while its connection is still the live one, else null. */
  readonly failure: RemoteUpdateCheckFailure | null;
}

export const IDLE_REMOTE_UPDATE_CHECK_STATE: RemoteUpdateCheckState = {
  inFlight: false,
  failure: null,
};

/**
 * What a settled check does to the recorded failure: success clears it, a failure over a
 * live connection replaces it, and a check that was interrupted, only lost its
 * connection, or started without one leaves it as it was.
 */
function nextRecordedCheckFailure(
  result: AtomCommandResult<unknown, unknown>,
  connection: RemoteUpdateConnection | null,
): RecordedRemoteUpdateCheckFailure | null | "unchanged" {
  if (result._tag === "Success") return null;
  if (connection === null || isRemoteUpdateConnectionFailure(result.cause)) return "unchanged";
  return { connection, failure: { cause: result.cause, generation: connection.generation } };
}

/** Status re-read period while the host checks, downloads, or installs. */
export const REMOTE_UPDATE_BUSY_REFRESH_MS = 2_500;
/**
 * Status re-read period while an automatic host has not checked yet. A desktop host
 * starts every launch at `idle` and runs its own first check about 15 seconds later.
 */
export const REMOTE_UPDATE_NOT_CHECKED_REFRESH_MS = 30_000;

/**
 * When to re-read `updater.status` after a snapshot arrives; `null` stops polling.
 * Terminal states and manual hosts change only through an explicit check, so they are
 * never polled; failed reads are not polled either (see `createEnvironmentQueryAtomFamily`).
 */
export function remoteUpdateStatusRefreshIntervalMs(snapshot: RemoteUpdateSnapshot): number | null {
  switch (snapshot.state) {
    case "checking":
    case "downloading":
    case "installing":
      return REMOTE_UPDATE_BUSY_REFRESH_MS;
    case "idle":
    case "update-available":
    case "up-to-date":
    case "error":
      return isRemoteUpdateUnchecked(snapshot) ? REMOTE_UPDATE_NOT_CHECKED_REFRESH_MS : null;
  }
}

/**
 * Per-environment update-state surface. The server owns the snapshot
 * (`updater.status` restores it after navigation/reconnect); the query atom family
 * keeps the last value per environment for instant re-render (spec section 6) and
 * re-reads it on `remoteUpdateStatusRefreshIntervalMs` while someone observes it.
 * `check` also records its own progress and failures in `checkState`, so every view of
 * an environment shows the same check outcome whichever view started the check.
 */
export function createRemoteUpdateEnvironmentAtoms<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
) {
  // Generations restart for each supervisor installation; both identify a live connection.
  const liveConnection = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(
        followStreamInEnvironment(
          environmentId,
          Stream.unwrap(
            EnvironmentSupervisor.pipe(
              Effect.map((supervisor) =>
                SubscriptionRef.changes(supervisor.state).pipe(
                  Stream.map((state) => (state.phase === "connected" ? state.generation : null)),
                  Stream.changes,
                  Stream.map((generation): RemoteUpdateConnection | null =>
                    generation === null ? null : { supervisor, generation },
                  ),
                ),
              ),
            ),
          ),
        ),
        { initialValue: null },
      )
      .pipe(Atom.withLabel(`environment-data:remote-update:live-connection:${environmentId}`)),
  );
  const recordedCheckFailure = Atom.family((environmentId: EnvironmentId) =>
    Atom.make<RecordedRemoteUpdateCheckFailure | null>(null).pipe(
      Atom.keepAlive,
      Atom.withLabel(`environment-data:remote-update:check-failure:${environmentId}`),
    ),
  );
  const runningChecks = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(
      Atom.keepAlive,
      Atom.withLabel(`environment-data:remote-update:running-checks:${environmentId}`),
    ),
  );
  const checkState = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): RemoteUpdateCheckState => {
      const connection = Option.getOrNull(AsyncResult.value(get(liveConnection(environmentId))));
      const recorded = get(recordedCheckFailure(environmentId));
      return {
        inFlight: get(runningChecks(environmentId)) > 0,
        failure:
          recorded !== null &&
          connection !== null &&
          recorded.connection.supervisor === connection.supervisor &&
          recorded.connection.generation === connection.generation
            ? recorded.failure
            : null,
      };
    }).pipe(Atom.withLabel(`environment-data:remote-update:check-state:${environmentId}`)),
  );
  const checkCommand = createEnvironmentCommand(runtime, {
    label: "environment-data:remote-update:check",
    timeoutMs: REMOTE_UPDATE_CHECK_TIMEOUT_MS,
    execute: (input: EnvironmentRpcInput<typeof WS_METHODS.updaterCheck>) =>
      request(WS_METHODS.updaterCheck, input),
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId }) => environmentId,
    },
  });
  const check: typeof checkCommand = {
    label: checkCommand.label,
    run: async (registry, target, options) => {
      const { environmentId } = target;
      // Stamp the connection the check starts on: a failure is shown only while that
      // connection lives, which also hides it while the environment is offline.
      const connection = Option.getOrNull(
        AsyncResult.value(registry.get(liveConnection(environmentId))),
      );
      registry.update(runningChecks(environmentId), (count) => count + 1);
      try {
        const result = await checkCommand.run(registry, target, options);
        const next = nextRecordedCheckFailure(result, connection);
        if (next !== "unchanged") {
          registry.set(recordedCheckFailure(environmentId), next);
        }
        return result;
      } finally {
        registry.update(runningChecks(environmentId), (count) => count - 1);
      }
    },
  };
  return {
    snapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:remote-update:snapshot",
      tag: WS_METHODS.updaterStatus,
      staleTimeMs: 30_000,
      refreshIntervalMs: remoteUpdateStatusRefreshIntervalMs,
    }),
    check,
    checkState,
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
