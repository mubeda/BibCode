import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Tracer from "effect/Tracer";

import type { ConnectionCatalogEntry, KnownEnvironment } from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  ConnectionBlockedError,
  type ConnectionAttemptError,
  ConnectionTransientError,
  type EnvironmentRoute,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import { eligibleRoutes } from "./routeSelection.ts";
import * as RpcSession from "../rpc/session.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import * as ConnectionWakeups from "./wakeups.ts";

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
const CONNECTION_ESTABLISHMENT_TIMEOUT = "15 seconds";
const CONNECTION_PROBE_TIMEOUT = "15 seconds";
const BACKOFF_RESET_AFTER_MS = 30_000;
const ROUTE_RESULT_HISTORY_LIMIT = 64;

interface SupervisorIntent {
  readonly desired: boolean;
  readonly network: NetworkStatus;
}

type SupervisorSignal =
  | { readonly _tag: "ConnectRequested" }
  | { readonly _tag: "DisconnectRequested" }
  | { readonly _tag: "RetryRequested" }
  | { readonly _tag: "NetworkChanged"; readonly network: NetworkStatus }
  | { readonly _tag: "Wakeup"; readonly reason: ConnectionWakeups.ConnectionWakeup };

interface PendingRetryTrace {
  readonly previousAttempt: Tracer.Span;
  readonly failureCount: number;
  readonly delayMs: number;
  readonly reason: ConnectionAttemptError["reason"];
}

interface TracedAttemptFailure {
  readonly error: ConnectionAttemptError;
  readonly attemptSpan: Option.Option<Tracer.Span>;
}

type AttemptOutcome =
  | {
      readonly _tag: "Interrupted";
      readonly established: boolean;
      readonly stable: boolean;
    }
  | {
      readonly _tag: "Failure";
      readonly established: boolean;
      readonly stable: boolean;
      readonly failure: TracedAttemptFailure;
    };

type EstablishmentEvent =
  | {
      readonly _tag: "Completed";
      readonly exit: Exit.Exit<
        {
          readonly attemptSpan: Option.Option<Tracer.Span>;
          readonly lease: ConnectionDriver.EnvironmentConnectionLease;
        },
        TracedAttemptFailure
      >;
    }
  | { readonly _tag: "Interrupted" }
  | { readonly _tag: "TimedOut" };

export type EnvironmentRouteResultOutcome = "connected" | "transient-failure" | "blocked";

/** A bounded, redacted operational record suitable for the Environment settings workspace. */
export interface EnvironmentRouteResult {
  readonly routeId: string;
  readonly environmentGeneration: number;
  readonly routeGeneration: number;
  readonly outcome: EnvironmentRouteResultOutcome;
  readonly recordedAt: number;
  readonly failure: ConnectionAttemptError | null;
}

function exitUnlessInterrupted<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Exit.Exit<A, E>, never, R> {
  return Effect.matchCauseEffect(effect, {
    onFailure: (cause) =>
      Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(Exit.failCause(cause)),
    onSuccess: (value) => Effect.succeed(Exit.succeed(value)),
  });
}

export interface EnvironmentSupervisorOptions {
  readonly initiallyDesired?: boolean;
  readonly environmentGeneration?: number;
  readonly attemptSemaphore?: Semaphore.Semaphore;
  readonly jitterRetryDelayMs?: (baseDelayMs: number, failureCount: number) => number;
}

function retryDelayMs(failureCount: number): number {
  return RETRY_DELAYS_MS[Math.min(failureCount, RETRY_DELAYS_MS.length - 1)] ?? 16_000;
}

function environmentLabel(environment: KnownEnvironment): string {
  return environment.alias ?? environment.descriptor?.label ?? "Environment";
}

function isLegacyCatalogEntry(
  input: KnownEnvironment | ConnectionCatalogEntry,
): input is ConnectionCatalogEntry {
  return "target" in input;
}

/** Bounded adapter for pre-v3 catalog rows. Normalized runtime callers pass KnownEnvironment. */
export function legacyCatalogEnvironment(input: ConnectionCatalogEntry): KnownEnvironment {
  const target = input.target;
  const routeBase = {
    routeId: "connectionId" in target ? `legacy:${target.connectionId}` : `legacy:${target._tag}`,
    environmentId: target.environmentId,
    label: target.label,
    priority: 0,
    pinned: false,
    autoconnect: true,
    secretRef: null,
  } as const;
  let route: EnvironmentRoute;
  if (target._tag === "PrimaryConnectionTarget") {
    route = {
      _tag: "DesktopLoopbackRoute",
      ...routeBase,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
    } as EnvironmentRoute;
  } else if (
    target._tag === "SshConnectionTarget" &&
    Option.isSome(input.profile) &&
    input.profile.value._tag === "SshConnectionProfile"
  ) {
    route = {
      _tag: "SshTunnelRoute",
      ...routeBase,
      target: input.profile.value.target,
      hostKeyFingerprint: null,
    } as EnvironmentRoute;
  } else {
    const profile =
      Option.isSome(input.profile) && input.profile.value._tag === "BearerConnectionProfile"
        ? input.profile.value
        : null;
    route = {
      _tag: "DirectHttpsRoute",
      ...routeBase,
      httpsBaseUrl: profile?.httpBaseUrl ?? "https://legacy-route.invalid",
      trust: { _tag: "System" },
    } as EnvironmentRoute;
  }
  return {
    environmentId: target.environmentId,
    acceptedStorageInstanceId: "00000000-0000-4000-8000-000000000000",
    descriptor: null,
    alias: target.label,
    hidden: false,
    bindings: [],
    routes: [route],
  } as KnownEnvironment;
}

function annotateRoute(environment: KnownEnvironment, route: EnvironmentRoute) {
  return Effect.annotateCurrentSpan({
    "environment.id": environment.environmentId,
    "environment.label": environmentLabel(environment),
    "environment.route.id": route.routeId,
    "environment.route.kind": route._tag,
  });
}

function availableState(intent: SupervisorIntent, generation: number): SupervisorConnectionState {
  return {
    desired: false,
    network: intent.network,
    phase: "available",
    stage: null,
    attempt: 0,
    generation,
    lastFailure: null,
    retryAt: null,
  };
}

function offlineState(
  intent: SupervisorIntent,
  generation: number,
  attempt: number,
  lastFailure: ConnectionAttemptError | null,
): SupervisorConnectionState {
  return {
    desired: true,
    network: intent.network,
    phase: "offline",
    stage: null,
    attempt,
    generation,
    lastFailure,
    retryAt: null,
  };
}

function connectingState(
  intent: SupervisorIntent,
  generation: number,
  attempt: number,
  lastFailure: ConnectionAttemptError | null,
  stage: SupervisorConnectionState["stage"] = "preparing",
): SupervisorConnectionState {
  return {
    desired: true,
    network: intent.network,
    phase: "connecting",
    stage,
    attempt,
    generation,
    lastFailure,
    retryAt: null,
  };
}

function failureFromExit<A>(
  label: string,
  exit: Exit.Exit<A, TracedAttemptFailure>,
  established: boolean,
  stable: boolean,
): AttemptOutcome {
  if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
    return { _tag: "Interrupted", established, stable };
  }
  const typedFailure = exit.cause.reasons.find(Cause.isFailReason);
  if (typedFailure) {
    return {
      _tag: "Failure",
      established,
      stable,
      failure: typedFailure.error,
    };
  }
  return {
    _tag: "Failure",
    established,
    stable,
    failure: {
      error: new ConnectionTransientError({
        reason: "transport",
        detail: `${label} connection failed unexpectedly.`,
      }),
      attemptSpan: Option.none(),
    },
  };
}

export class EnvironmentSupervisor extends Context.Service<
  EnvironmentSupervisor,
  {
    readonly environment: KnownEnvironment;
    /** Transitional display projection; runtime ownership remains the environment aggregate. */
    readonly target: {
      readonly environmentId: KnownEnvironment["environmentId"];
      readonly label: string;
    };
    readonly activeRouteId: SubscriptionRef.SubscriptionRef<string | null>;
    readonly routeResults: SubscriptionRef.SubscriptionRef<ReadonlyArray<EnvironmentRouteResult>>;
    readonly state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>;
    readonly session: SubscriptionRef.SubscriptionRef<Option.Option<RpcSession.RpcSession>>;
    readonly prepared: SubscriptionRef.SubscriptionRef<Option.Option<PreparedConnection>>;
    readonly connect: Effect.Effect<void>;
    readonly disconnect: Effect.Effect<void>;
    readonly retryNow: Effect.Effect<void>;
  }
>()("@bibcode/client-runtime/connection/supervisor/EnvironmentSupervisor") {}

export const make = Effect.fn("EnvironmentSupervisor.make")(function* (
  input: KnownEnvironment | ConnectionCatalogEntry,
  options?: EnvironmentSupervisorOptions,
): Effect.fn.Return<
  EnvironmentSupervisor["Service"],
  never,
  | Connectivity.Connectivity
  | ConnectionDriver.ConnectionDriver
  | Scope.Scope
  | ConnectionWakeups.ConnectionWakeups
> {
  const legacyEntry: ConnectionCatalogEntry | null = isLegacyCatalogEntry(input) ? input : null;
  const environment: KnownEnvironment = isLegacyCatalogEntry(input)
    ? legacyCatalogEnvironment(input)
    : input;
  const connectivity = yield* Connectivity.Connectivity;
  const driver = yield* ConnectionDriver.ConnectionDriver;
  const wakeups = yield* ConnectionWakeups.ConnectionWakeups;
  const environmentGeneration = options?.environmentGeneration ?? 1;
  const initialIntent: SupervisorIntent = {
    desired: options?.initiallyDesired ?? false,
    network: yield* connectivity.status,
  };
  const intent = yield* Ref.make(initialIntent);
  const signals = yield* Queue.unbounded<SupervisorSignal>();
  const attemptFence = yield* Ref.make(0);
  const routeGenerationCounter = yield* Ref.make(0);
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>(
    !initialIntent.desired
      ? availableState(initialIntent, 0)
      : initialIntent.network === "offline"
        ? offlineState(initialIntent, 0, 0, null)
        : connectingState(initialIntent, 0, 1, null),
  );
  const session = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(Option.none());
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none());
  const activeRouteId = yield* SubscriptionRef.make<string | null>(null);
  const routeResults = yield* SubscriptionRef.make<ReadonlyArray<EnvironmentRouteResult>>([]);

  const clearLease = Effect.all(
    [
      SubscriptionRef.set(session, Option.none()),
      SubscriptionRef.set(prepared, Option.none()),
      SubscriptionRef.set(activeRouteId, null),
    ],
    { discard: true },
  );

  const setState = Effect.fn("EnvironmentSupervisor.setState")(function* (
    next: SupervisorConnectionState,
  ) {
    yield* SubscriptionRef.set(state, next);
  });

  const invalidateAttempt = Ref.set(attemptFence, -1);
  const signal = Effect.fn("EnvironmentSupervisor.signal")(function* (
    next: SupervisorSignal,
    invalidate = false,
  ) {
    if (invalidate) {
      yield* invalidateAttempt;
    }
    yield* Queue.offer(signals, next);
  });

  const isCurrentRouteGeneration = (routeGeneration: number) =>
    Ref.get(attemptFence).pipe(Effect.map((current) => current === routeGeneration));

  const recordRouteResult = Effect.fn("EnvironmentSupervisor.recordRouteResult")(function* (
    routeId: string,
    routeGeneration: number,
    outcome: EnvironmentRouteResultOutcome,
    failure: ConnectionAttemptError | null,
  ) {
    const result: EnvironmentRouteResult = {
      routeId,
      environmentGeneration,
      routeGeneration,
      outcome,
      recordedAt: yield* Clock.currentTimeMillis,
      failure,
    };
    yield* SubscriptionRef.update(routeResults, (current) =>
      [...current, result].slice(-ROUTE_RESULT_HISTORY_LIMIT),
    );
  });

  const reportProgress = Effect.fn("EnvironmentSupervisor.reportProgress")(function* (
    attempt: number,
    routeGeneration: number,
    lastFailure: ConnectionAttemptError | null,
    progress: ConnectionDriver.ConnectionDriverProgress,
  ) {
    if (!(yield* isCurrentRouteGeneration(routeGeneration))) {
      return;
    }
    if ("prepared" in progress && progress.stage === "synchronizing") {
      yield* SubscriptionRef.set(prepared, Option.some(progress.prepared));
    }
    yield* setState(
      connectingState(
        yield* Ref.get(intent),
        routeGeneration,
        attempt,
        lastFailure,
        progress.stage,
      ),
    );
  });

  const establishConnection = Effect.fnUntraced(function* (
    route: EnvironmentRoute,
    attempt: number,
    routeGeneration: number,
    lastFailure: ConnectionAttemptError | null,
  ) {
    const cancellation = new AbortController();
    yield* Effect.addFinalizer(() => Effect.sync(() => cancellation.abort()));
    return yield* driver.connect(
      legacyEntry ?? {
        environment,
        route,
        environmentGeneration,
        routeGeneration,
        cancellation: cancellation.signal,
      },
      (progress) => reportProgress(attempt, routeGeneration, lastFailure, progress),
    );
  });

  const establishTracedConnection = Effect.fnUntraced(function* (
    route: EnvironmentRoute,
    attempt: number,
    routeGeneration: number,
    lastFailure: ConnectionAttemptError | null,
    pendingRetry: Option.Option<PendingRetryTrace>,
  ) {
    const traced = Effect.gen(function* () {
      const attemptSpan = yield* Effect.currentSpan.pipe(Effect.orDie);
      yield* annotateRoute(environment, route);
      yield* Effect.annotateCurrentSpan({
        "connection.attempt": attempt,
        "connection.environment.generation": environmentGeneration,
        "connection.route.generation": routeGeneration,
        "connection.retry.failure_count": Option.match(pendingRetry, {
          onNone: () => 0,
          onSome: (retry) => retry.failureCount,
        }),
      });
      const lease = yield* establishConnection(route, attempt, routeGeneration, lastFailure).pipe(
        Effect.mapError(
          (error): TracedAttemptFailure => ({
            error,
            attemptSpan: Option.some(attemptSpan),
          }),
        ),
      );
      return { attemptSpan: Option.some(attemptSpan), lease };
    }).pipe(Effect.withSpan("environment.route.connection.attempt", { root: true }));

    return yield* Option.match(pendingRetry, {
      onNone: () => traced,
      onSome: (retry) =>
        traced.pipe(
          Effect.linkSpans(retry.previousAttempt, {
            "connection.retry.delay_ms": retry.delayMs,
            "connection.retry.reason": retry.reason,
          }),
        ),
    });
  });

  const waitForEstablishmentInterrupt = Effect.fnUntraced(function* () {
    for (;;) {
      const next = yield* Queue.take(signals);
      switch (next._tag) {
        case "DisconnectRequested":
        case "RetryRequested":
          return;
        case "NetworkChanged":
          if (next.network === "offline") {
            return;
          }
          break;
        case "ConnectRequested":
        case "Wakeup":
          break;
      }
    }
  });

  const monitorConnectedLease = Effect.fnUntraced(function* (
    lease: ConnectionDriver.EnvironmentConnectionLease,
  ) {
    for (;;) {
      const next = yield* Queue.take(signals);
      switch (next._tag) {
        case "DisconnectRequested":
        case "RetryRequested":
          return;
        case "NetworkChanged":
          if (next.network === "offline") {
            return;
          }
          break;
        case "Wakeup":
          if (next.reason === "application-active") {
            const probe = yield* lease.session.probe.pipe(
              Effect.timeoutOrElse({
                duration: CONNECTION_PROBE_TIMEOUT,
                orElse: () =>
                  Effect.fail(
                    new ConnectionTransientError({
                      reason: "timeout",
                      detail: `${environmentLabel(environment)} did not respond to a connection health check.`,
                    }),
                  ),
              }),
              Effect.forkChild,
            );
            for (;;) {
              const probeEvent = yield* Effect.raceFirst(
                Fiber.await(probe).pipe(
                  Effect.map((exit) => ({ _tag: "ProbeCompleted" as const, exit })),
                ),
                Queue.take(signals).pipe(
                  Effect.map((queued) => ({ _tag: "Signal" as const, signal: queued })),
                ),
              );
              if (probeEvent._tag === "ProbeCompleted") {
                yield* probeEvent.exit;
                break;
              }
              switch (probeEvent.signal._tag) {
                case "DisconnectRequested":
                case "RetryRequested":
                  yield* Fiber.interrupt(probe);
                  return;
                case "NetworkChanged":
                  if (probeEvent.signal.network === "offline") {
                    yield* Fiber.interrupt(probe);
                    return;
                  }
                  break;
                case "ConnectRequested":
                case "Wakeup":
                  break;
              }
            }
          }
          break;
        case "ConnectRequested":
          break;
      }
    }
  });

  const withAttemptPermit = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    options?.attemptSemaphore === undefined
      ? effect
      : options.attemptSemaphore.withPermits(1)(effect);

  const runAttempt = Effect.fnUntraced(function* (
    route: EnvironmentRoute,
    attempt: number,
    routeGeneration: number,
    lastFailure: ConnectionAttemptError | null,
    pendingRetry: Option.Option<PendingRetryTrace>,
  ) {
    yield* clearLease;
    const establishOrTimeout = withAttemptPermit(
      Effect.raceAllFirst([
        exitUnlessInterrupted(
          establishTracedConnection(route, attempt, routeGeneration, lastFailure, pendingRetry),
        ).pipe(
          Effect.map(
            (exit): EstablishmentEvent => ({
              _tag: "Completed",
              exit,
            }),
          ),
        ),
        Effect.sleep(CONNECTION_ESTABLISHMENT_TIMEOUT).pipe(
          Effect.as<EstablishmentEvent>({ _tag: "TimedOut" }),
        ),
      ]),
    );
    const establishment = yield* Effect.raceFirst(
      establishOrTimeout,
      waitForEstablishmentInterrupt().pipe(Effect.as<EstablishmentEvent>({ _tag: "Interrupted" })),
    );

    if (establishment._tag === "Interrupted") {
      return { _tag: "Interrupted", established: false, stable: false } satisfies AttemptOutcome;
    }
    if (establishment._tag === "TimedOut") {
      return {
        _tag: "Failure",
        established: false,
        stable: false,
        failure: {
          error: new ConnectionTransientError({
            reason: "timeout",
            detail: `${route.label} did not respond during connection setup.`,
          }),
          attemptSpan: Option.none(),
        },
      } satisfies AttemptOutcome;
    }
    if (Exit.isFailure(establishment.exit)) {
      const isUnexpectedDefect =
        !Cause.hasInterruptsOnly(establishment.exit.cause) &&
        !establishment.exit.cause.reasons.some(Cause.isFailReason);
      const outcome = failureFromExit(route.label, establishment.exit, false, false);
      if (isUnexpectedDefect) {
        const defect = establishment.exit.cause.reasons.find(Cause.isDieReason)?.defect;
        yield* Effect.logError("Connection attempt failed with an unexpected defect.").pipe(
          Effect.annotateLogs({
            "environment.id": environment.environmentId,
            "environment.route.id": route.routeId,
            "environment.route.kind": route._tag,
            "cause.reason_count": establishment.exit.cause.reasons.length,
            ...safeErrorLogAttributes(defect),
          }),
        );
      }
      return outcome;
    }

    if (!(yield* isCurrentRouteGeneration(routeGeneration))) {
      return { _tag: "Interrupted", established: false, stable: false } satisfies AttemptOutcome;
    }
    const active = establishment.exit.value;
    const currentIntent = yield* Ref.get(intent);
    if (!currentIntent.desired || currentIntent.network === "offline") {
      return { _tag: "Interrupted", established: false, stable: false } satisfies AttemptOutcome;
    }

    const connectedAt = yield* Clock.currentTimeMillis;
    yield* SubscriptionRef.set(prepared, Option.some(active.lease.prepared));
    yield* SubscriptionRef.set(session, Option.some(active.lease.session));
    yield* SubscriptionRef.set(activeRouteId, route.routeId);
    yield* recordRouteResult(route.routeId, routeGeneration, "connected", null);
    yield* setState({
      desired: true,
      network: currentIntent.network,
      phase: "connected",
      stage: null,
      attempt,
      generation: routeGeneration,
      lastFailure: null,
      retryAt: null,
    });

    const connectedExit = yield* Effect.raceFirst(
      active.lease.session.closed.pipe(
        Effect.mapError(
          (error): TracedAttemptFailure => ({
            error,
            attemptSpan: active.attemptSpan,
          }),
        ),
      ),
      monitorConnectedLease(active.lease).pipe(
        Effect.mapError(
          (error): TracedAttemptFailure => ({
            error,
            attemptSpan: active.attemptSpan,
          }),
        ),
      ),
    ).pipe(exitUnlessInterrupted);
    const connectedForMs = (yield* Clock.currentTimeMillis) - connectedAt;
    return failureFromExit(
      route.label,
      connectedExit,
      true,
      connectedForMs >= BACKOFF_RESET_AFTER_MS,
    );
  }, Effect.ensuring(clearLease));

  const waitForRetrySignal = Effect.fnUntraced(function* (delayMs: number) {
    return yield* Effect.raceFirst(
      Effect.sleep(delayMs).pipe(Effect.as<Option.Option<SupervisorSignal>>(Option.none())),
      Queue.take(signals).pipe(Effect.map(Option.some)),
    );
  });

  const clearBlockedRoutesForSignal = (
    next: SupervisorSignal,
    blockedRouteIds: Set<string>,
  ): void => {
    if (
      next._tag === "RetryRequested" ||
      (next._tag === "Wakeup" && next.reason === "credentials-changed")
    ) {
      blockedRouteIds.clear();
    }
  };

  const run = Effect.fnUntraced(function* () {
    let failureCount = 0;
    let attemptCount = 0;
    let latestFailure: ConnectionAttemptError | null = null;
    let pendingRetry = Option.none<PendingRetryTrace>();
    const blockedRouteIds = new Set<string>();

    for (;;) {
      const currentIntent = yield* Ref.get(intent);
      const currentRouteGeneration = yield* Ref.get(routeGenerationCounter);
      if (!currentIntent.desired) {
        failureCount = 0;
        attemptCount = 0;
        latestFailure = null;
        pendingRetry = Option.none();
        blockedRouteIds.clear();
        yield* clearLease;
        yield* setState(availableState(currentIntent, currentRouteGeneration));
        const next = yield* Queue.take(signals);
        clearBlockedRoutesForSignal(next, blockedRouteIds);
        continue;
      }
      if (currentIntent.network === "offline") {
        yield* clearLease;
        yield* setState(
          offlineState(currentIntent, currentRouteGeneration, attemptCount, latestFailure),
        );
        const next = yield* Queue.take(signals);
        clearBlockedRoutesForSignal(next, blockedRouteIds);
        continue;
      }

      const routes = eligibleRoutes(environment, {
        activeRouteId: yield* SubscriptionRef.get(activeRouteId),
        blockedRouteIds,
      });
      if (routes.length === 0) {
        const noRouteFailure: ConnectionAttemptError =
          latestFailure ??
          new ConnectionBlockedError({
            reason: "configuration",
            detail: `${environmentLabel(environment)} has no eligible connection route.`,
          });
        latestFailure = noRouteFailure;
        yield* setState({
          desired: true,
          network: currentIntent.network,
          phase: "blocked",
          stage: null,
          attempt: attemptCount,
          generation: currentRouteGeneration,
          lastFailure: noRouteFailure,
          retryAt: null,
        });
        const next = yield* Queue.take(signals);
        clearBlockedRoutesForSignal(next, blockedRouteIds);
        continue;
      }

      let interrupted = false;
      let transientFailure: TracedAttemptFailure | null = null;
      for (const route of routes) {
        attemptCount += 1;
        const routeGeneration = yield* Ref.updateAndGet(
          routeGenerationCounter,
          (generation) => generation + 1,
        );
        yield* Ref.set(attemptFence, routeGeneration);
        const outcome: AttemptOutcome = yield* Effect.scoped(
          runAttempt(route, attemptCount, routeGeneration, latestFailure, pendingRetry),
        );
        pendingRetry = Option.none();
        if (outcome.stable) {
          failureCount = 0;
          attemptCount = 0;
          latestFailure = null;
        }
        if (outcome._tag === "Interrupted") {
          interrupted = true;
          break;
        }

        const error: ConnectionAttemptError = outcome.failure.error;
        latestFailure = error;
        if (
          error._tag === "ConnectionBlockedError" ||
          error._tag === "ConnectionStorageChangedError"
        ) {
          blockedRouteIds.add(route.routeId);
          yield* recordRouteResult(route.routeId, routeGeneration, "blocked", error);
          continue;
        }
        transientFailure = outcome.failure;
        yield* recordRouteResult(route.routeId, routeGeneration, "transient-failure", error);
      }

      if (interrupted) {
        continue;
      }
      if (transientFailure === null) {
        const blockedIntent = yield* Ref.get(intent);
        yield* setState({
          desired: blockedIntent.desired,
          network: blockedIntent.network,
          phase: "blocked",
          stage: null,
          attempt: attemptCount,
          generation: yield* Ref.get(routeGenerationCounter),
          lastFailure: latestFailure,
          retryAt: null,
        });
        const next = yield* Queue.take(signals);
        clearBlockedRoutesForSignal(next, blockedRouteIds);
        continue;
      }

      failureCount += 1;
      const baseDelayMs = retryDelayMs(failureCount - 1);
      const delayMs = Math.max(
        0,
        Math.round(options?.jitterRetryDelayMs?.(baseDelayMs, failureCount) ?? baseDelayMs),
      );
      pendingRetry = Option.map(transientFailure.attemptSpan, (previousAttempt) => ({
        previousAttempt,
        failureCount,
        delayMs,
        reason: transientFailure.error.reason,
      }));
      const failedIntent = yield* Ref.get(intent);
      yield* setState({
        desired: failedIntent.desired,
        network: failedIntent.network,
        phase: "backoff",
        stage: null,
        attempt: attemptCount,
        generation: yield* Ref.get(routeGenerationCounter),
        lastFailure: transientFailure.error,
        retryAt: (yield* Clock.currentTimeMillis) + delayMs,
      });
      const wake = yield* waitForRetrySignal(delayMs);
      if (Option.isSome(wake)) {
        clearBlockedRoutesForSignal(wake.value, blockedRouteIds);
      }
    }
  });

  yield* connectivity.changes.pipe(
    Stream.runForEach((network) =>
      Ref.modify(intent, (current) =>
        current.network === network ? [false, current] : ([true, { ...current, network }] as const),
      ).pipe(
        Effect.flatMap((changed) =>
          changed
            ? signal({ _tag: "NetworkChanged", network }, network === "offline")
            : Effect.void,
        ),
      ),
    ),
    Effect.forkScoped,
  );
  yield* wakeups.changes.pipe(
    Stream.runForEach((reason) => signal({ _tag: "Wakeup", reason })),
    Effect.forkScoped,
  );
  yield* run().pipe(Effect.forkScoped);

  const connect = Ref.update(intent, (current) => ({
    ...current,
    desired: true,
  })).pipe(
    Effect.andThen(signal({ _tag: "ConnectRequested" })),
    Effect.withSpan("EnvironmentSupervisor.connect"),
  );

  const disconnect = Ref.update(intent, (current) => ({
    ...current,
    desired: false,
  })).pipe(
    Effect.andThen(signal({ _tag: "DisconnectRequested" }, true)),
    Effect.withSpan("EnvironmentSupervisor.disconnect"),
  );

  const retryNow = signal({ _tag: "RetryRequested" }, true).pipe(
    Effect.withSpan("EnvironmentSupervisor.retryNow"),
  );

  yield* Effect.addFinalizer(() => Queue.shutdown(signals).pipe(Effect.andThen(clearLease)));

  return EnvironmentSupervisor.of({
    environment,
    target: {
      environmentId: environment.environmentId,
      label: environmentLabel(environment),
    },
    activeRouteId,
    routeResults,
    state,
    session,
    prepared,
    connect,
    disconnect,
    retryNow,
  });
});

export const layer = (
  environment: KnownEnvironment | ConnectionCatalogEntry,
  options?: EnvironmentSupervisorOptions,
): Layer.Layer<
  EnvironmentSupervisor,
  never,
  | Connectivity.Connectivity
  | ConnectionDriver.ConnectionDriver
  | ConnectionWakeups.ConnectionWakeups
> => Layer.effect(EnvironmentSupervisor, make(environment, options));
