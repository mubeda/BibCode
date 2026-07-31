import {
  ActivityError,
  WS_METHODS,
  type ActivityScopeRef,
  type ActivitySnapshot,
  type ActivityStreamItem,
  type EnvironmentId,
} from "@bibcode/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionProjectionPhase, type SupervisorConnectionState } from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { request, subscribeInSession } from "../rpc/client.ts";
import { applyEnvironmentActivityDelta, type EnvironmentActivityState } from "./activityReducer.ts";
import {
  createEnvironmentRpcQueryAtomFamily,
  environmentRpcKey,
  followStreamInEnvironment,
  parseEnvironmentRpcKey,
} from "./runtime.ts";

export type { EnvironmentActivityState } from "./activityReducer.ts";

// Scope changes must tear down the old stream before a late delta can affect a new scope.
export const ACTIVITY_STATE_IDLE_TTL_MS = 0;
export const ACTIVITY_QUERY_STALE_TIME_MS = 2_000;
export const ACTIVITY_QUERY_IDLE_TTL_MS = 0;

const ACTIVITY_STREAM_ERROR_MESSAGE = "Could not synchronize activity.";
const ACTIVITY_CAPABILITY_ERROR_MESSAGE = "Could not determine activity support.";
const ACTIVITY_SNAPSHOT_ERROR_MESSAGE = "Could not refresh activity.";
const isActivityError = Schema.is(ActivityError);

function isFeatureDisabledActivityFailure(failure: unknown): boolean {
  return isActivityError(failure) && failure.reason === "featureDisabled";
}

function hasFeatureDisabledActivityFailure(cause: {
  readonly reasons: ReadonlyArray<{ readonly _tag: string; readonly error?: unknown }>;
}): boolean {
  return cause.reasons.some(
    (reason) => reason._tag === "Fail" && isFeatureDisabledActivityFailure(reason.error),
  );
}

function emptyActivityState(): EnvironmentActivityState {
  return {
    snapshot: Option.none(),
    status: "empty",
    error: Option.none(),
    recentEntries: new Map(),
  };
}

export const EMPTY_ENVIRONMENT_ACTIVITY_STATE: EnvironmentActivityState = emptyActivityState();

function scopeRefEqual(left: ActivityScopeRef, right: ActivityScopeRef): boolean {
  if (left._tag !== right._tag) {
    return false;
  }
  switch (left._tag) {
    case "thread":
      return left.threadId === right.threadId;
    case "terminal":
      return (
        right._tag === "terminal" &&
        left.threadId === right.threadId &&
        left.terminalId === right.terminalId
      );
  }
}

function snapshotCanReplace(
  current: Option.Option<ActivitySnapshot>,
  incoming: ActivitySnapshot,
): boolean {
  if (Option.isNone(current)) {
    return true;
  }
  return current.value.scopeId !== incoming.scopeId || incoming.revision >= current.value.revision;
}

function stateWithSnapshot(
  current: EnvironmentActivityState,
  incoming: ActivitySnapshot,
): EnvironmentActivityState {
  if (!snapshotCanReplace(current.snapshot, incoming)) {
    return current;
  }
  return {
    snapshot: Option.some(incoming),
    status: "live",
    error: Option.none(),
    recentEntries:
      Option.isSome(current.snapshot) && current.snapshot.value.scopeId !== incoming.scopeId
        ? new Map()
        : current.recentEntries,
  };
}

function stateWithoutLiveConnection(current: EnvironmentActivityState): EnvironmentActivityState {
  return {
    ...current,
    status: Option.isSome(current.snapshot) ? "stale" : "empty",
  };
}

function stateSynchronizing(current: EnvironmentActivityState): EnvironmentActivityState {
  if (current.status === "live") {
    return current;
  }
  return {
    ...current,
    status: "synchronizing",
    error: Option.none(),
  };
}

function stateCheckingCapability(current: EnvironmentActivityState): EnvironmentActivityState {
  return {
    ...current,
    status: Option.isSome(current.snapshot) ? "stale" : "synchronizing",
    error: Option.none(),
  };
}

function stateUnsupported(): EnvironmentActivityState {
  return {
    snapshot: Option.none(),
    status: "empty",
    error: Option.none(),
    recentEntries: new Map(),
  };
}

function stateWithError(
  current: EnvironmentActivityState,
  message: string,
): EnvironmentActivityState {
  return {
    ...current,
    status: Option.isSome(current.snapshot) ? "stale" : "synchronizing",
    error: Option.some(message),
  };
}

export const makeEnvironmentActivityState = Effect.fn("EnvironmentActivityState.make")(function* (
  scope: ActivityScopeRef,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const state = yield* SubscriptionRef.make<EnvironmentActivityState>(emptyActivityState());
  const stateLock = yield* Semaphore.make(1);
  const stateVersion = yield* Ref.make(0);
  const sessionEpoch = yield* Ref.make(0);
  const negotiatedCapability = yield* Ref.make<"checking" | "supported" | "unsupported">(
    "checking",
  );
  const acceptedScopeId = yield* Ref.make<string | null>(null);
  const recoverySequence = yield* Ref.make(0);
  interface RecoveryToken {
    readonly id: number;
    readonly sessionEpoch: number;
    readonly baseVersion: number;
  }
  const activeRecovery = yield* Ref.make<RecoveryToken | null>(null);
  const featureDisabled = yield* Deferred.make<void>();

  const transitionFeatureDisabled = Effect.fn("EnvironmentActivityState.transitionFeatureDisabled")(
    function* () {
      yield* stateLock.withPermits(1)(
        Effect.gen(function* () {
          yield* Ref.set(activeRecovery, null);
          yield* Ref.set(negotiatedCapability, "unsupported");
          yield* SubscriptionRef.set(state, stateUnsupported());
          const currentVersion = yield* Ref.get(stateVersion);
          yield* Ref.set(stateVersion, currentVersion + 1);
        }),
      );
      yield* Deferred.succeed(featureDisabled, undefined);
    },
  );

  const retireMatchingRecovery = Effect.fn("EnvironmentActivityState.retireMatchingRecovery")(
    function* (epoch: number, baseVersion: number) {
      yield* Ref.update(activeRecovery, (current) =>
        current?.sessionEpoch === epoch && current.baseVersion === baseVersion ? null : current,
      );
    },
  );

  const replaceSnapshotLocked = Effect.fn("EnvironmentActivityState.replaceSnapshotLocked")(
    function* (incoming: ActivitySnapshot, epoch: number) {
      if (!scopeRefEqual(scope, incoming.scope)) {
        return;
      }
      yield* Ref.set(acceptedScopeId, incoming.scopeId);
      const current = yield* SubscriptionRef.get(state);
      const next = stateWithSnapshot(current, incoming);
      if (next === current) {
        return;
      }
      const previousVersion = yield* Ref.get(stateVersion);
      yield* SubscriptionRef.set(state, next);
      yield* Ref.set(stateVersion, previousVersion + 1);
      yield* retireMatchingRecovery(epoch, previousVersion);
    },
  );

  const completeRecovery = Effect.fn("EnvironmentActivityState.completeRecovery")(function* (
    token: RecoveryToken,
    incoming: ActivitySnapshot,
  ) {
    yield* stateLock.withPermits(1)(
      Effect.gen(function* () {
        const currentRecovery = yield* Ref.get(activeRecovery);
        const currentEpoch = yield* Ref.get(sessionEpoch);
        const currentVersion = yield* Ref.get(stateVersion);
        if (
          currentRecovery?.id !== token.id ||
          currentRecovery.sessionEpoch !== token.sessionEpoch ||
          currentRecovery.baseVersion !== token.baseVersion ||
          currentEpoch !== token.sessionEpoch ||
          currentVersion !== token.baseVersion
        ) {
          return;
        }

        yield* replaceSnapshotLocked(incoming, token.sessionEpoch);
        yield* Ref.update(activeRecovery, (current) => (current?.id === token.id ? null : current));
      }),
    );
  });

  const failRecovery = Effect.fn("EnvironmentActivityState.failRecovery")(function* (
    token: RecoveryToken,
  ) {
    yield* stateLock.withPermits(1)(
      Effect.gen(function* () {
        const currentRecovery = yield* Ref.get(activeRecovery);
        const currentEpoch = yield* Ref.get(sessionEpoch);
        const currentVersion = yield* Ref.get(stateVersion);
        if (
          currentRecovery?.id !== token.id ||
          currentRecovery.sessionEpoch !== token.sessionEpoch ||
          currentRecovery.baseVersion !== token.baseVersion ||
          currentEpoch !== token.sessionEpoch ||
          currentVersion !== token.baseVersion
        ) {
          return;
        }

        const current = yield* SubscriptionRef.get(state);
        yield* SubscriptionRef.set(state, stateWithError(current, ACTIVITY_SNAPSHOT_ERROR_MESSAGE));
        yield* Ref.set(stateVersion, currentVersion + 1);
        yield* Ref.set(activeRecovery, null);
      }),
    );
  });

  const clearRecovery = Effect.fn("EnvironmentActivityState.clearRecovery")(function* (
    token: RecoveryToken,
  ) {
    yield* stateLock.withPermits(1)(
      Ref.update(activeRecovery, (current) => (current?.id === token.id ? null : current)),
    );
  });

  const runRecovery = Effect.fn("EnvironmentActivityState.runRecovery")(function* (
    token: RecoveryToken,
  ) {
    yield* request(WS_METHODS.activityGetSnapshot, scope).pipe(
      Effect.flatMap((incoming) => completeRecovery(token, incoming)),
      Effect.catchCause((cause) =>
        hasFeatureDisabledActivityFailure(cause)
          ? transitionFeatureDisabled()
          : failRecovery(token),
      ),
      Effect.ensuring(clearRecovery(token)),
    );
  });

  const beginRecoveryLocked = Effect.fn("EnvironmentActivityState.beginRecoveryLocked")(function* (
    epoch: number,
  ) {
    const current = yield* Ref.get(activeRecovery);
    if (current !== null) {
      return null;
    }
    const recoveryId = yield* Ref.updateAndGet(recoverySequence, (value) => value + 1);
    const baseVersion = yield* Ref.get(stateVersion);
    const token = {
      id: recoveryId,
      sessionEpoch: epoch,
      baseVersion,
    };
    yield* Ref.set(activeRecovery, token);
    return token;
  });

  const applyStreamItem = Effect.fn("EnvironmentActivityState.applyStreamItem")(function* (
    epoch: number,
    item: ActivityStreamItem,
  ) {
    const recovery = yield* stateLock.withPermits(1)(
      Effect.gen(function* () {
        const currentEpoch = yield* Ref.get(sessionEpoch);
        if (currentEpoch !== epoch) {
          return null;
        }

        switch (item.kind) {
          case "snapshot":
            yield* replaceSnapshotLocked(item.snapshot, epoch);
            return null;
          case "delta": {
            const acceptedScope = yield* Ref.get(acceptedScopeId);
            if (acceptedScope !== null && acceptedScope !== item.delta.scopeId) {
              return null;
            }
            const current = yield* SubscriptionRef.get(state);
            if (
              Option.isSome(current.snapshot) &&
              current.snapshot.value.scopeId !== item.delta.scopeId
            ) {
              return null;
            }
            const previousVersion = yield* Ref.get(stateVersion);
            const result = applyEnvironmentActivityDelta(current, item.delta);
            if (result.state !== current) {
              yield* SubscriptionRef.set(state, result.state);
              yield* Ref.set(stateVersion, previousVersion + 1);
            }
            switch (result.kind) {
              case "applied":
                yield* retireMatchingRecovery(epoch, previousVersion);
                return null;
              case "duplicate":
                return null;
              case "gap":
                return yield* beginRecoveryLocked(epoch);
            }
          }
        }
      }),
    );
    if (recovery !== null) {
      yield* runRecovery(recovery).pipe(Effect.forkScoped);
    }
  });

  const projectConnectionStateLocked = Effect.fn(
    "EnvironmentActivityState.projectConnectionStateLocked",
  )(function* (connectionState: SupervisorConnectionState) {
    const capability = yield* Ref.get(negotiatedCapability);
    if (capability === "unsupported") {
      yield* SubscriptionRef.update(state, stateUnsupported);
      return;
    }
    switch (connectionProjectionPhase(connectionState)) {
      case "synchronizing":
        yield* SubscriptionRef.update(state, stateCheckingCapability);
        return;
      case "disconnected":
        yield* SubscriptionRef.update(state, stateWithoutLiveConnection);
        return;
      case "ready":
        yield* SubscriptionRef.update(
          state,
          capability === "supported" ? stateSynchronizing : stateCheckingCapability,
        );
        return;
    }
  });

  const projectCurrentConnectionStateLocked = Effect.fn(
    "EnvironmentActivityState.projectCurrentConnectionStateLocked",
  )(function* () {
    yield* projectConnectionStateLocked(yield* SubscriptionRef.get(supervisor.state));
  });

  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((connectionState) =>
      stateLock.withPermits(1)(projectConnectionStateLocked(connectionState)),
    ),
    Effect.forkScoped,
  );

  const gatedActivityStream = SubscriptionRef.changes(supervisor.session).pipe(
    Stream.mapEffect((session) =>
      stateLock.withPermits(1)(
        Ref.updateAndGet(sessionEpoch, (current) => current + 1).pipe(
          Effect.tap(() => Ref.set(activeRecovery, null)),
          Effect.tap(() => Ref.set(negotiatedCapability, "checking")),
          Effect.tap(() => projectCurrentConnectionStateLocked()),
          Effect.map((epoch) => ({ epoch, session })),
        ),
      ),
    ),
    Stream.switchMap(({ epoch, session }) =>
      Option.match(session, {
        onNone: () => Stream.empty,
        onSome: (currentSession) =>
          Stream.fromEffect(
            currentSession.initialConfig.pipe(
              Effect.matchEffect({
                onFailure: () =>
                  stateLock.withPermits(1)(
                    SubscriptionRef.update(state, (current) =>
                      stateWithError(current, ACTIVITY_CAPABILITY_ERROR_MESSAGE),
                    ).pipe(Effect.as(false)),
                  ),
                onSuccess: (config) => {
                  const supported = config.environment.capabilities.activityProtocolVersion === 1;
                  return stateLock.withPermits(1)(
                    Ref.set(negotiatedCapability, supported ? "supported" : "unsupported").pipe(
                      Effect.andThen(projectCurrentConnectionStateLocked()),
                      Effect.as(supported),
                    ),
                  );
                },
              }),
            ),
          ).pipe(
            Stream.flatMap((supported) =>
              supported
                ? subscribeInSession(
                    currentSession,
                    supervisor.target.environmentId,
                    WS_METHODS.subscribeActivity,
                    scope,
                    {
                      onExpectedFailure: (cause) =>
                        hasFeatureDisabledActivityFailure(cause)
                          ? transitionFeatureDisabled()
                          : SubscriptionRef.update(state, (current) =>
                              stateWithError(current, ACTIVITY_STREAM_ERROR_MESSAGE),
                            ),
                      retryExpectedFailureAfter: "250 millis",
                    },
                  ).pipe(Stream.map((item) => ({ epoch, item })))
                : Stream.empty,
            ),
          ),
      }),
    ),
  );

  yield* gatedActivityStream.pipe(
    Stream.interruptWhen(Deferred.await(featureDisabled)),
    Stream.runForEach(({ epoch, item }) => applyStreamItem(epoch, item)),
    Effect.forkScoped,
  );

  return state;
});

interface EnvironmentActivityTarget {
  readonly environmentId: EnvironmentId;
  readonly input: ActivityScopeRef;
}

export function createEnvironmentActivityAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const stateFamily = Atom.family((key: string) => {
    const target = parseEnvironmentRpcKey<ActivityScopeRef>(key);
    return runtime
      .atom(
        followStreamInEnvironment(
          target.environmentId,
          Stream.unwrap(
            makeEnvironmentActivityState(target.input).pipe(Effect.map(SubscriptionRef.changes)),
          ),
        ),
        { initialValue: EMPTY_ENVIRONMENT_ACTIVITY_STATE },
      )
      .pipe(
        Atom.setIdleTTL(ACTIVITY_STATE_IDLE_TTL_MS),
        Atom.withLabel(`environment-activity-state:${key}`),
      );
  });
  const stateAtom = (target: EnvironmentActivityTarget) => stateFamily(environmentRpcKey(target));
  const stateValueFamily = Atom.family((key: string) => {
    const target = parseEnvironmentRpcKey<ActivityScopeRef>(key);
    return Atom.make(
      (get): EnvironmentActivityState =>
        Option.getOrElse(AsyncResult.value(get(stateAtom(target))), () => emptyActivityState()),
    ).pipe(
      Atom.setIdleTTL(ACTIVITY_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-activity-state-value:${key}`),
    );
  });
  const stateValueAtom = (target: EnvironmentActivityTarget) =>
    stateValueFamily(environmentRpcKey(target));

  return {
    stateAtom,
    stateValueAtom,
    roster: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:activity:roster",
      tag: WS_METHODS.activityListRoster,
      staleTimeMs: ACTIVITY_QUERY_STALE_TIME_MS,
      idleTtlMs: ACTIVITY_QUERY_IDLE_TTL_MS,
    }),
    detail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:activity:detail",
      tag: WS_METHODS.activityListDetail,
      staleTimeMs: ACTIVITY_QUERY_STALE_TIME_MS,
      idleTtlMs: ACTIVITY_QUERY_IDLE_TTL_MS,
    }),
  };
}
