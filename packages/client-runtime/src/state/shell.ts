import {
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamItem,
  type ServerConfig,
} from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import type { SupervisorConnectionState } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { subscribe } from "../rpc/client.ts";
import { applyShellStreamEvent } from "./shellReducer.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import { followStreamInEnvironment } from "./runtime.ts";

export type EnvironmentAvailabilityStatus =
  | "starting"
  | "synchronizing"
  | "live"
  | "degraded"
  | "storage-changed"
  | "recovery-required"
  | "unavailable"
  | "configuration-error";

export interface EnvironmentShellState {
  readonly snapshot: Option.Option<OrchestrationShellSnapshot>;
  readonly status: EnvironmentAvailabilityStatus;
  readonly error: Option.Option<string>;
}

const EMPTY_SHELL_STATE: EnvironmentShellState = {
  snapshot: Option.none(),
  status: "starting",
  error: Option.none(),
};

function cachedAvailabilityStatus(
  snapshot: Option.Option<OrchestrationShellSnapshot>,
): "degraded" | "unavailable" {
  return Option.isSome(snapshot) ? "degraded" : "unavailable";
}

export function resolveEnvironmentAvailabilityStatus(input: {
  readonly connection: SupervisorConnectionState;
  readonly snapshot: Option.Option<OrchestrationShellSnapshot>;
  readonly currentStatus: EnvironmentAvailabilityStatus;
}): EnvironmentAvailabilityStatus {
  const { connection, currentStatus, snapshot } = input;
  switch (connection.phase) {
    case "connecting":
      if (connection.stage === "synchronizing") {
        return "synchronizing";
      }
      return Option.isSome(snapshot) ? "degraded" : "starting";
    case "connected":
      return currentStatus === "live" ? "live" : "synchronizing";
    case "blocked":
      if (connection.lastFailure?._tag === "ConnectionStorageChangedError") {
        return "storage-changed";
      }
      if (connection.lastFailure?.reason === "recovery-required") {
        return "recovery-required";
      }
      return "configuration-error";
    case "available":
    case "offline":
    case "backoff":
      return cachedAvailabilityStatus(snapshot);
  }
}

const SHELL_SYNCHRONIZATION_ERROR_MESSAGE = "Could not synchronize environment data.";

export const makeEnvironmentShellState = Effect.fn("EnvironmentShellState.make")(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const environmentId = supervisor.target.environmentId;
  const cachedSnapshot = yield* cache.loadShell(environmentId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached environment shell.").pipe(
        Effect.annotateLogs({
          environmentId,
          ...safeErrorLogAttributes(error),
        }),
        Effect.as(Option.none<OrchestrationShellSnapshot>()),
      ),
    ),
  );
  const state = yield* SubscriptionRef.make<EnvironmentShellState>({
    snapshot: cachedSnapshot,
    status: Option.isSome(cachedSnapshot) ? "degraded" : "starting",
    error: Option.none(),
  });
  const persistence = yield* Queue.sliding<OrchestrationShellSnapshot>(1);

  const persist = Effect.fn("EnvironmentShellState.persist")(function* (
    snapshot: OrchestrationShellSnapshot,
  ) {
    yield* cache.saveShell(environmentId, snapshot).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not persist environment shell cache.").pipe(
          Effect.annotateLogs({
            environmentId,
            ...safeErrorLogAttributes(error),
          }),
        ),
      ),
    );
  });

  yield* Stream.fromQueue(persistence).pipe(
    Stream.debounce("500 millis"),
    Stream.runForEach(persist),
    Effect.forkScoped,
  );

  const setConnectionState = (connection: SupervisorConnectionState) =>
    SubscriptionRef.update(state, (current) => {
      const status = resolveEnvironmentAvailabilityStatus({
        connection,
        snapshot: current.snapshot,
        currentStatus: current.status,
      });
      const error =
        connection.phase === "blocked" && connection.lastFailure !== null
          ? Option.some(connection.lastFailure.message)
          : status === "starting" || status === "synchronizing" || status === "live"
            ? Option.none<string>()
            : current.error;
      return current.status === status &&
        Option.getOrNull(current.error) === Option.getOrNull(error)
        ? current
        : { ...current, status, error };
    });
  const setStreamError = (error: unknown) =>
    Effect.logWarning("Could not synchronize the environment shell.").pipe(
      Effect.annotateLogs({
        environmentId,
        ...safeErrorLogAttributes(error),
      }),
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          status: cachedAvailabilityStatus(current.snapshot),
          error: Option.some(SHELL_SYNCHRONIZATION_ERROR_MESSAGE),
        })),
      ),
    );

  const applyItem = Effect.fn("EnvironmentShellState.applyItem")(function* (
    item: OrchestrationShellStreamItem,
  ) {
    const current = yield* SubscriptionRef.get(state);
    const nextSnapshot =
      item.kind === "snapshot"
        ? item.snapshot
        : Option.match(current.snapshot, {
            onNone: () => null,
            onSome: (snapshot) =>
              item.sequence > snapshot.snapshotSequence
                ? applyShellStreamEvent(snapshot, item)
                : snapshot,
          });
    if (nextSnapshot === null) {
      return;
    }

    yield* SubscriptionRef.set(state, {
      snapshot: Option.some(nextSnapshot),
      status: "live",
      error: Option.none(),
    });
    yield* Queue.offer(persistence, nextSnapshot);
  });

  yield* subscribe(
    ORCHESTRATION_WS_METHODS.subscribeShell,
    {},
    {
      onExpectedFailure: (cause) => setStreamError(Cause.squash(cause)),
    },
  ).pipe(Stream.runForEach(applyItem), Effect.forkScoped);
  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach(setConnectionState),
    Effect.forkScoped,
  );

  return state;
});

export function shellStateChanges(environmentId: EnvironmentId) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(makeEnvironmentShellState().pipe(Effect.map(SubscriptionRef.changes))),
  );
}

export interface EnvironmentShellSummary {
  readonly catalogReady: boolean;
  readonly desiredEnvironmentCount: number;
  readonly statuses: ReadonlyArray<EnvironmentShellAvailability>;
  readonly canShowEmptyProjects: boolean;
  readonly hasSnapshot: boolean;
  readonly hasSynchronizingShell: boolean;
  readonly hasCachedShell: boolean;
  readonly hasLiveShell: boolean;
  readonly firstError: string | null;
  readonly latestSnapshotUpdatedAt: string | null;
}

export interface EnvironmentShellAvailability {
  readonly environmentId: EnvironmentId;
  readonly status: EnvironmentAvailabilityStatus;
  readonly hasSnapshot: boolean;
  readonly error: string | null;
}

const EMPTY_ENVIRONMENT_SHELL_SUMMARY: EnvironmentShellSummary = Object.freeze({
  catalogReady: false,
  desiredEnvironmentCount: 0,
  statuses: Object.freeze([]),
  canShowEmptyProjects: false,
  hasSnapshot: false,
  hasSynchronizingShell: false,
  hasCachedShell: false,
  hasLiveShell: false,
  firstError: null,
  latestSnapshotUpdatedAt: null,
});

const EMPTY_SERVER_CONFIGS: ReadonlyMap<EnvironmentId, ServerConfig> = new Map();

function shellSummariesEqual(
  left: EnvironmentShellSummary,
  right: EnvironmentShellSummary,
): boolean {
  return (
    left.catalogReady === right.catalogReady &&
    left.desiredEnvironmentCount === right.desiredEnvironmentCount &&
    left.canShowEmptyProjects === right.canShowEmptyProjects &&
    left.statuses.length === right.statuses.length &&
    left.statuses.every((status, index) => {
      const candidate = right.statuses[index];
      return (
        candidate !== undefined &&
        status.environmentId === candidate.environmentId &&
        status.status === candidate.status &&
        status.hasSnapshot === candidate.hasSnapshot &&
        status.error === candidate.error
      );
    }) &&
    left.hasSnapshot === right.hasSnapshot &&
    left.hasSynchronizingShell === right.hasSynchronizingShell &&
    left.hasCachedShell === right.hasCachedShell &&
    left.hasLiveShell === right.hasLiveShell &&
    left.firstError === right.firstError &&
    left.latestSnapshotUpdatedAt === right.latestSnapshotUpdatedAt
  );
}

function mapsEqual<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
}

export function createEnvironmentShellSummaryAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly shellStateValueAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
}) {
  let previousSummary = EMPTY_ENVIRONMENT_SHELL_SUMMARY;
  return Atom.make((get) => {
    const catalog = get(input.catalogValueAtom);
    const statuses: EnvironmentShellAvailability[] = [];
    let hasSnapshot = false;
    let hasSynchronizingShell = false;
    let hasCachedShell = false;
    let hasLiveShell = false;
    let firstError: string | null = null;
    let latestSnapshotUpdatedAt: string | null = null;

    for (const environmentId of catalog.entries.keys()) {
      const state = get(input.shellStateValueAtom(environmentId));
      hasSynchronizingShell ||= state.status === "synchronizing";
      hasCachedShell ||= Option.isSome(state.snapshot) && state.status !== "live";
      hasLiveShell ||= state.status === "live";
      statuses.push({
        environmentId,
        status: state.status,
        hasSnapshot: Option.isSome(state.snapshot),
        error: Option.getOrNull(state.error),
      });
      if (firstError === null) {
        firstError = Option.getOrNull(state.error);
      }
      if (Option.isNone(state.snapshot)) {
        continue;
      }
      hasSnapshot = true;
      const updatedAt = state.snapshot.value.updatedAt;
      if (latestSnapshotUpdatedAt === null || updatedAt > latestSnapshotUpdatedAt) {
        latestSnapshotUpdatedAt = updatedAt;
      }
    }

    const next: EnvironmentShellSummary = {
      catalogReady: catalog.isReady,
      desiredEnvironmentCount: catalog.entries.size,
      statuses,
      canShowEmptyProjects:
        catalog.isReady &&
        statuses.length > 0 &&
        statuses.every((status) => status.status === "live" && status.hasSnapshot),
      hasSnapshot,
      hasSynchronizingShell,
      hasCachedShell,
      hasLiveShell,
      firstError,
      latestSnapshotUpdatedAt,
    };
    if (shellSummariesEqual(previousSummary, next)) {
      return previousSummary;
    }
    previousSummary = next;
    return previousSummary;
  }).pipe(Atom.withLabel("environment-shell-summary"));
}

export function createEnvironmentServerConfigsAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly serverConfigValueAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerConfig | null>;
}) {
  let previousServerConfigs = EMPTY_SERVER_CONFIGS;
  return Atom.make((get) => {
    const next = new Map<EnvironmentId, ServerConfig>();
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      const config = get(input.serverConfigValueAtom(environmentId));
      if (config !== null) {
        next.set(environmentId, config);
      }
    }
    if (mapsEqual(previousServerConfigs, next)) {
      return previousServerConfigs;
    }
    previousServerConfigs = next;
    return previousServerConfigs;
  }).pipe(Atom.withLabel("environment-server-configs"));
}

export function createEnvironmentShellAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
) {
  const stateAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(shellStateChanges(environmentId), {
      initialValue: EMPTY_SHELL_STATE,
    }),
  );

  const stateValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      Option.getOrElse(AsyncResult.value(get(stateAtom(environmentId))), () => EMPTY_SHELL_STATE),
    ).pipe(Atom.withLabel(`environment-shell-state-value:${environmentId}`)),
  );

  return {
    stateAtom,
    stateValueAtom,
  };
}

export * from "./models.ts";
export * from "./shellCommands.ts";
export * from "./shellReducer.ts";
export * from "./snapshots.ts";
