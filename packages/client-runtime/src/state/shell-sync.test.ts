import {
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamItem,
} from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionStorageChangedError,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { threadActivityAgeMs } from "./models.ts";
import {
  type EnvironmentAvailabilityStatus,
  makeEnvironmentShellState,
  setShellIncludeHints,
  shellSubscribeInput,
} from "./shell.ts";
import { offShellThreads } from "./offShellThreads.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const LIVE_SHELL_SNAPSHOT: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  projects: [],
  threads: [],
  updatedAt: "2026-06-06T00:00:00.000Z",
};

const CACHED_PROJECT = {
  id: ProjectId.make("cached-project"),
  title: "Cached project",
  workspaceRoot: "/cached/project",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  codeReviewPrompt: "",
  worktreeDiscovery: {
    visibility: "hidden",
    initialPromptDismissedAt: null,
    baselinePaths: [],
  },
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
} as const;

const yieldForShell = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, {
  discard: true,
});

function session(client: WsRpcProtocolClient): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
    e2eeAuthenticated: Effect.succeed(null),
  };
}

describe("environment shell synchronization", () => {
  it.effect("ignores all deltas until the current session publishes a full snapshot", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationShellStreamItem>();
      const client = {
        [ORCHESTRATION_WS_METHODS.subscribeShell]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
        Option.some(session(client)),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: supervisorState,
        session: activeSession,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const saveCount = yield* Ref.make(0);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: () => Ref.update(saveCount, (count) => count + 1),
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        clear: () => Effect.void,
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
      );
      yield* SubscriptionRef.set(supervisorState, {
        desired: true,
        network: "online",
        phase: "connected",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });
      yield* yieldForShell;

      const statuses: ReadonlyArray<EnvironmentAvailabilityStatus> = [
        "starting",
        "synchronizing",
        "degraded",
        "storage-changed",
        "unavailable",
      ];
      const deltaSequences = [5, 4, 3] as const;
      for (const projects of [[], [CACHED_PROJECT]] as const) {
        const cachedSnapshot: OrchestrationShellSnapshot = {
          snapshotSequence: 4,
          projects,
          threads: [],
          updatedAt: "2026-06-01T00:00:00.000Z",
        };
        for (const status of statuses) {
          for (const sequence of deltaSequences) {
            yield* SubscriptionRef.set(shellState, {
              snapshot: Option.some(cachedSnapshot),
              status,
              error: Option.none(),
            });
            yield* Queue.offer(events, {
              kind: "project-removed",
              sequence,
              projectId: CACHED_PROJECT.id,
            });
            yield* yieldForShell;
            const current = yield* SubscriptionRef.get(shellState);
            expect(current.status).toBe(status);
            expect(Option.getOrThrow(current.snapshot)).toBe(cachedSnapshot);
            expect(Option.getOrThrow(current.snapshot).projects).toEqual(projects);
          }
        }
      }

      yield* TestClock.adjust("1 second");
      expect(yield* Ref.get(saveCount)).toBe(0);
    }),
  );

  it.effect("starts synchronization when the session is published after connected state", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationShellStreamItem>();
      const currentSession = session({
        [ORCHESTRATION_WS_METHODS.subscribeShell]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient);
      const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
        Option.none(),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: supervisorState,
        session: activeSession,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        clear: () => Effect.void,
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
      );

      yield* SubscriptionRef.set(supervisorState, {
        desired: true,
        network: "online",
        phase: "connected",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });
      yield* yieldForShell;
      expect((yield* SubscriptionRef.get(shellState)).status).toBe("synchronizing");

      yield* SubscriptionRef.set(activeSession, Option.some(currentSession));
      yield* yieldForShell;
      yield* Queue.offer(events, {
        kind: "snapshot",
        snapshot: LIVE_SHELL_SNAPSHOT,
      });
      yield* yieldForShell;
      const live = yield* SubscriptionRef.get(shellState);
      expect(live.status).toBe("live");
      expect(Option.getOrThrow(live.snapshot)).toBe(LIVE_SHELL_SNAPSHOT);
    }),
  );

  it.effect(
    "requires a full snapshot again after reconnect before accepting current-session deltas",
    () =>
      Effect.gen(function* () {
        const firstEvents = yield* Queue.unbounded<OrchestrationShellStreamItem>();
        const nextEvents = yield* Queue.unbounded<OrchestrationShellStreamItem>();
        const firstSession = session({
          [ORCHESTRATION_WS_METHODS.subscribeShell]: () => Stream.fromQueue(firstEvents),
        } as unknown as WsRpcProtocolClient);
        const nextSession = session({
          [ORCHESTRATION_WS_METHODS.subscribeShell]: () => Stream.fromQueue(nextEvents),
        } as unknown as WsRpcProtocolClient);
        const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
        const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
          Option.some(firstSession),
        );
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: supervisorState,
          session: activeSession,
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const savedSequences = yield* Ref.make<ReadonlyArray<number>>([]);
        const cache = Persistence.EnvironmentCacheStore.of({
          loadShell: () => Effect.succeed(Option.none()),
          saveShell: (_environmentId, snapshot) =>
            Ref.update(savedSequences, (sequences) => [...sequences, snapshot.snapshotSequence]),
          loadThread: () => Effect.succeed(Option.none()),
          saveThread: () => Effect.void,
          removeThread: () => Effect.void,
          clear: () => Effect.void,
        });
        const shellState = yield* makeEnvironmentShellState().pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        );
        yield* SubscriptionRef.set(supervisorState, {
          desired: true,
          network: "online",
          phase: "connected",
          stage: null,
          attempt: 1,
          generation: 1,
          lastFailure: null,
          retryAt: null,
        });
        yield* yieldForShell;
        yield* Queue.offer(firstEvents, {
          kind: "snapshot",
          snapshot: { ...LIVE_SHELL_SNAPSHOT, projects: [CACHED_PROJECT] },
        });
        yield* SubscriptionRef.changes(shellState).pipe(
          Stream.filter((state) => state.status === "live"),
          Stream.runHead,
        );
        yield* Queue.offer(firstEvents, {
          kind: "project-removed",
          sequence: 2,
          projectId: CACHED_PROJECT.id,
        });
        yield* SubscriptionRef.changes(shellState).pipe(
          Stream.filter(
            (state) => Option.isSome(state.snapshot) && state.snapshot.value.snapshotSequence === 2,
          ),
          Stream.runHead,
        );
        yield* TestClock.adjust("1 second");
        const savesBeforeReconnectDelta = yield* Ref.get(savedSequences);

        yield* SubscriptionRef.set(activeSession, Option.some(nextSession));
        yield* yieldForShell;
        const invalidatedSession = yield* SubscriptionRef.get(shellState);
        expect(invalidatedSession.status).toBe("synchronizing");
        yield* Queue.offer(firstEvents, {
          kind: "project-upserted",
          sequence: 3,
          project: { ...CACHED_PROJECT, title: "Stale prior-session project" },
        });
        yield* yieldForShell;
        expect(yield* SubscriptionRef.get(shellState)).toBe(invalidatedSession);
        yield* Queue.offer(nextEvents, {
          kind: "snapshot",
          snapshot: {
            ...LIVE_SHELL_SNAPSHOT,
            projects: [{ ...CACHED_PROJECT, title: "Premature next-session project" }],
          },
        });
        yield* yieldForShell;
        expect(yield* SubscriptionRef.get(shellState)).toBe(invalidatedSession);
        yield* Queue.take(nextEvents);

        yield* SubscriptionRef.set(supervisorState, {
          desired: true,
          network: "online",
          phase: "connecting",
          stage: "synchronizing",
          attempt: 2,
          generation: 2,
          lastFailure: null,
          retryAt: null,
        });
        yield* SubscriptionRef.set(supervisorState, {
          desired: true,
          network: "online",
          phase: "connected",
          stage: null,
          attempt: 2,
          generation: 2,
          lastFailure: null,
          retryAt: null,
        });
        yield* yieldForShell;
        const cachedBeforeDelta = yield* SubscriptionRef.get(shellState);
        expect(cachedBeforeDelta.status).toBe("synchronizing");

        yield* Queue.offer(nextEvents, {
          kind: "project-upserted",
          sequence: 3,
          project: { ...CACHED_PROJECT, title: "Must not appear before the snapshot" },
        });
        yield* yieldForShell;
        yield* TestClock.adjust("1 second");
        const awaitingSnapshot = yield* SubscriptionRef.get(shellState);
        expect(awaitingSnapshot).toBe(cachedBeforeDelta);
        expect(awaitingSnapshot.status).toBe("synchronizing");
        expect(Option.getOrThrow(awaitingSnapshot.snapshot).projects).toEqual([]);
        expect(yield* Ref.get(savedSequences)).toEqual(savesBeforeReconnectDelta);

        yield* Queue.offer(nextEvents, {
          kind: "snapshot",
          snapshot: { ...LIVE_SHELL_SNAPSHOT, snapshotSequence: 1 },
        });
        yield* SubscriptionRef.changes(shellState).pipe(
          Stream.filter((state) => state.status === "live"),
          Stream.runHead,
        );
        yield* Queue.offer(nextEvents, {
          kind: "project-upserted",
          sequence: 2,
          project: { ...CACHED_PROJECT, title: "Current project" },
        });
        yield* SubscriptionRef.changes(shellState).pipe(
          Stream.filter(
            (state) => Option.isSome(state.snapshot) && state.snapshot.value.snapshotSequence === 2,
          ),
          Stream.runHead,
        );
        yield* TestClock.adjust("1 second");
        const liveAfterDelta = yield* SubscriptionRef.get(shellState);
        expect(liveAfterDelta.status).toBe("live");
        expect(
          Option.getOrThrow(liveAfterDelta.snapshot).projects.map((project) => project.title),
        ).toEqual(["Current project"]);
        const savesBeforeIgnoredDeltas = yield* Ref.get(savedSequences);

        yield* Queue.offer(nextEvents, {
          kind: "project-removed",
          sequence: 2,
          projectId: CACHED_PROJECT.id,
        });
        yield* Queue.offer(nextEvents, {
          kind: "project-removed",
          sequence: 1,
          projectId: CACHED_PROJECT.id,
        });
        yield* yieldForShell;
        yield* TestClock.adjust("1 second");
        expect(yield* SubscriptionRef.get(shellState)).toBe(liveAfterDelta);
        expect(yield* Ref.get(savedSequences)).toEqual(savesBeforeIgnoredDeltas);
      }),
  );

  it.effect(
    "applies the server's delta items after its snapshot, drops their redelivery and takes a resync snapshot",
    () =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<OrchestrationShellStreamItem>();
        const client = {
          [ORCHESTRATION_WS_METHODS.subscribeShell]: () => Stream.fromQueue(events),
        } as unknown as WsRpcProtocolClient;
        const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
        const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
          Option.some(session(client)),
        );
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: supervisorState,
          session: activeSession,
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const savedSequences = yield* Ref.make<ReadonlyArray<number>>([]);
        const cache = Persistence.EnvironmentCacheStore.of({
          loadShell: () => Effect.succeed(Option.none()),
          saveShell: (_environmentId, snapshot) =>
            Ref.update(savedSequences, (sequences) => [...sequences, snapshot.snapshotSequence]),
          loadThread: () => Effect.succeed(Option.none()),
          saveThread: () => Effect.void,
          removeThread: () => Effect.void,
          clear: () => Effect.void,
        });
        const shellState = yield* makeEnvironmentShellState().pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        );
        yield* SubscriptionRef.set(supervisorState, {
          desired: true,
          network: "online",
          phase: "connected",
          stage: null,
          attempt: 1,
          generation: 1,
          lastFailure: null,
          retryAt: null,
        });
        yield* yieldForShell;
        const thread = (id: string, title: string) => ({
          id: ThreadId.make(id),
          projectId: CACHED_PROJECT.id,
          title,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
          archivedAt: null,
          session: null,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        });
        const sequenceReaches = (sequence: number) =>
          SubscriptionRef.changes(shellState).pipe(
            Stream.filter(
              (state) =>
                Option.isSome(state.snapshot) && state.snapshot.value.snapshotSequence === sequence,
            ),
            Stream.runHead,
          );

        yield* Queue.offer(events, {
          kind: "snapshot",
          snapshot: {
            ...LIVE_SHELL_SNAPSHOT,
            snapshotSequence: 4,
            projects: [CACHED_PROJECT],
            threads: [thread("streaming", "Before"), thread("archived", "Archived")],
          },
        });
        yield* sequenceReaches(4);
        const deltas: ReadonlyArray<OrchestrationShellStreamItem> = [
          {
            kind: "thread-upserted",
            sequence: 6,
            thread: {
              ...thread("streaming", "During"),
              lastActivityAt: "2026-06-01T00:00:05.000Z",
              lastActivityAgeMs: 800,
            },
          },
          { kind: "thread-removed", sequence: 7, threadId: ThreadId.make("archived") },
        ];
        yield* TestClock.setTime(10_000);
        yield* Queue.offerAll(events, deltas);
        yield* sequenceReaches(7);
        yield* TestClock.adjust("1 second");
        const afterDeltas = yield* SubscriptionRef.get(shellState);
        expect(afterDeltas.status).toBe("live");
        // The age is pinned to the receipt: the thread is not sent again while unchanged.
        expect(Option.getOrThrow(afterDeltas.snapshot).threads).toEqual([
          expect.objectContaining({
            id: "streaming",
            title: "During",
            lastActivityAgeMs: 800,
            lastActivityObservedAt: 10_000 - 800,
          }),
        ]);
        expect((yield* Ref.get(savedSequences)).at(-1)).toBe(7);

        // A duplicate delivery publishes and persists nothing.
        const savesBeforeDuplicate = yield* Ref.get(savedSequences);
        yield* Queue.offerAll(events, deltas);
        yield* yieldForShell;
        yield* TestClock.adjust("1 second");
        expect(yield* SubscriptionRef.get(shellState)).toBe(afterDeltas);
        expect(yield* Ref.get(savedSequences)).toEqual(savesBeforeDuplicate);

        // After the server's receiver lagged it sends a whole snapshot, which replaces the shell.
        yield* Queue.offer(events, {
          kind: "snapshot",
          snapshot: {
            ...LIVE_SHELL_SNAPSHOT,
            snapshotSequence: 12,
            projects: [CACHED_PROJECT],
            threads: [thread("streaming", "Resynced")],
          },
        });
        yield* sequenceReaches(12);
        const resynced = yield* SubscriptionRef.get(shellState);
        expect(resynced.status).toBe("live");
        expect(Option.getOrThrow(resynced.snapshot).threads.map((entry) => entry.title)).toEqual([
          "Resynced",
        ]);
      }),
  );

  it.effect("clears a blocked storage error when the connection becomes generically degraded", () =>
    Effect.gen(function* () {
      const client = {
        [ORCHESTRATION_WS_METHODS.subscribeShell]: () => Stream.never,
      } as unknown as WsRpcProtocolClient;
      const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
        Option.some(session(client)),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: supervisorState,
        session: activeSession,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.some(LIVE_SHELL_SNAPSHOT)),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        clear: () => Effect.void,
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
      );
      const storageFailure = new ConnectionStorageChangedError({
        reason: "storage-changed",
        detail: "The old storage location is blocked.",
        targetKey: "platform:primary",
        acceptedStorageInstanceId: "accepted",
        reportedStorageInstanceId: "reported",
      });
      yield* SubscriptionRef.set(supervisorState, {
        desired: true,
        network: "online",
        phase: "blocked",
        stage: null,
        attempt: 1,
        generation: 0,
        lastFailure: storageFailure,
        retryAt: null,
      });
      yield* yieldForShell;
      expect(Option.getOrNull((yield* SubscriptionRef.get(shellState)).error)).toBe(
        storageFailure.message,
      );

      yield* SubscriptionRef.set(supervisorState, {
        desired: true,
        network: "online",
        phase: "backoff",
        stage: null,
        attempt: 2,
        generation: 0,
        lastFailure: new ConnectionTransientError({
          reason: "transport",
          detail: "Retrying after transport loss.",
        }),
        retryAt: 1_000,
      });
      yield* yieldForShell;
      const degraded = yield* SubscriptionRef.get(shellState);
      expect(degraded.status).toBe("degraded");
      expect(Option.isNone(degraded.error)).toBe(true);
    }),
  );

  it.effect("publishes live state before persistence and preserves it when ready", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationShellStreamItem>();
      const client = {
        [ORCHESTRATION_WS_METHODS.subscribeShell]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
        Option.some(session(client)),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: supervisorState,
        session: activeSession,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: () => Effect.never,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        clear: () => Effect.void,
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
      );

      yield* SubscriptionRef.set(supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 1,
        generation: 0,
        lastFailure: null,
        retryAt: null,
      });
      for (let index = 0; index < 10; index += 1) {
        yield* Effect.yieldNow;
      }
      expect((yield* SubscriptionRef.get(shellState)).status).toBe("synchronizing");
      yield* SubscriptionRef.set(supervisorState, {
        desired: true,
        network: "offline",
        phase: "offline",
        stage: null,
        attempt: 1,
        generation: 0,
        lastFailure: null,
        retryAt: null,
      });
      for (let index = 0; index < 10; index += 1) {
        yield* Effect.yieldNow;
      }
      expect((yield* SubscriptionRef.get(shellState)).status).toBe("unavailable");
      yield* SubscriptionRef.set(supervisorState, {
        desired: true,
        network: "online",
        phase: "connected",
        stage: null,
        attempt: 1,
        generation: 0,
        lastFailure: null,
        retryAt: null,
      });
      for (let index = 0; index < 10; index += 1) {
        yield* Effect.yieldNow;
      }
      expect((yield* SubscriptionRef.get(shellState)).status).toBe("synchronizing");
      yield* Queue.offer(events, {
        kind: "project-removed",
        sequence: 1,
        projectId: ProjectId.make("missing-project"),
      });
      for (let index = 0; index < 10; index += 1) {
        yield* Effect.yieldNow;
      }
      expect(Option.isNone((yield* SubscriptionRef.get(shellState)).snapshot)).toBe(true);

      yield* Queue.offer(events, {
        kind: "snapshot",
        snapshot: LIVE_SHELL_SNAPSHOT,
      });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((state) => state.status === "live"),
        Stream.runHead,
      );
      yield* Queue.offer(events, {
        kind: "project-removed",
        sequence: 1,
        projectId: ProjectId.make("missing-project"),
      });
      for (let index = 0; index < 10; index += 1) {
        yield* Effect.yieldNow;
      }
      expect(Option.getOrThrow((yield* SubscriptionRef.get(shellState)).snapshot)).toBe(
        LIVE_SHELL_SNAPSHOT,
      );
      yield* Queue.offer(events, {
        kind: "project-removed",
        sequence: 2,
        projectId: ProjectId.make("missing-project"),
      });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter(
          (next) => Option.isSome(next.snapshot) && next.snapshot.value.snapshotSequence === 2,
        ),
        Stream.runHead,
      );

      yield* SubscriptionRef.set(supervisorState, {
        desired: true,
        network: "online",
        phase: "connected",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });
      for (let index = 0; index < 10; index += 1) {
        yield* Effect.yieldNow;
      }

      let state = yield* SubscriptionRef.get(shellState);
      expect(state.status).toBe("synchronizing");
      expect(Option.getOrThrow(state.snapshot).snapshotSequence).toBe(2);

      yield* Queue.offer(events, {
        kind: "snapshot",
        snapshot: LIVE_SHELL_SNAPSHOT,
      });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((next) => next.status === "live"),
        Stream.runHead,
      );
      state = yield* SubscriptionRef.get(shellState);
      expect(state.status).toBe("live");
      expect(Option.getOrThrow(state.snapshot)).toBe(LIVE_SHELL_SNAPSHOT);
    }),
  );

  it.effect(
    "retains cached projects through a storage mismatch until an adopted live empty snapshot arrives",
    () =>
      Effect.gen(function* () {
        const cachedSnapshot: OrchestrationShellSnapshot = {
          snapshotSequence: 4,
          projects: [
            {
              id: ProjectId.make("cached-project"),
              title: "Cached project",
              workspaceRoot: "/cached/project",
              repositoryIdentity: null,
              defaultModelSelection: null,
              scripts: [],
              codeReviewPrompt: "",
              worktreeDiscovery: {
                visibility: "hidden",
                initialPromptDismissedAt: null,
                baselinePaths: [],
              },
              createdAt: "2026-06-01T00:00:00.000Z",
              updatedAt: "2026-06-01T00:00:00.000Z",
            },
          ],
          threads: [],
          updatedAt: "2026-06-01T00:00:00.000Z",
        };
        const events = yield* Queue.unbounded<OrchestrationShellStreamItem>();
        const client = {
          [ORCHESTRATION_WS_METHODS.subscribeShell]: () => Stream.fromQueue(events),
        } as unknown as WsRpcProtocolClient;
        const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
        const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
          Option.some(session(client)),
        );
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: supervisorState,
          session: activeSession,
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const cache = Persistence.EnvironmentCacheStore.of({
          loadShell: () => Effect.succeed(Option.some(cachedSnapshot)),
          saveShell: () => Effect.void,
          loadThread: () => Effect.succeed(Option.none()),
          saveThread: () => Effect.void,
          removeThread: () => Effect.void,
          clear: () => Effect.void,
        });
        const shellState = yield* makeEnvironmentShellState().pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        );

        expect((yield* SubscriptionRef.get(shellState)).status).toBe("degraded");
        yield* SubscriptionRef.set(supervisorState, {
          desired: true,
          network: "online",
          phase: "blocked",
          stage: null,
          attempt: 1,
          generation: 0,
          lastFailure: new ConnectionStorageChangedError({
            reason: "storage-changed",
            detail: "The environment reported a different persistent store.",
            targetKey: "platform:primary",
            acceptedStorageInstanceId: "11111111-1111-4111-8111-111111111111",
            reportedStorageInstanceId: "22222222-2222-4222-8222-222222222222",
          }),
          retryAt: null,
        });
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        let current = yield* SubscriptionRef.get(shellState);
        expect(current.status).toBe("storage-changed");
        expect(
          Option.getOrThrow(current.snapshot).projects.map((project) => project.title),
        ).toEqual(["Cached project"]);

        // Explicit adoption schedules the normal retry. The accepted cache is
        // retained while that retry synchronizes the newly accepted store.
        yield* SubscriptionRef.set(supervisorState, {
          desired: true,
          network: "online",
          phase: "connecting",
          stage: "synchronizing",
          attempt: 2,
          generation: 0,
          lastFailure: null,
          retryAt: null,
        });
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        current = yield* SubscriptionRef.get(shellState);
        expect(current.status).toBe("synchronizing");
        expect(Option.getOrThrow(current.snapshot).projects).toHaveLength(1);

        yield* SubscriptionRef.set(supervisorState, {
          desired: true,
          network: "online",
          phase: "connected",
          stage: null,
          attempt: 2,
          generation: 1,
          lastFailure: null,
          retryAt: null,
        });
        yield* yieldForShell;
        yield* Queue.offer(events, {
          kind: "snapshot",
          snapshot: {
            snapshotSequence: 1,
            projects: [],
            threads: [],
            updatedAt: "2026-06-07T00:00:00.000Z",
          },
        });
        yield* SubscriptionRef.changes(shellState).pipe(
          Stream.filter((state) => state.status === "live"),
          Stream.runHead,
        );
        current = yield* SubscriptionRef.get(shellState);
        expect(current.status).toBe("live");
        expect(Option.getOrThrow(current.snapshot).projects).toEqual([]);
      }),
  );
});

describe("shell cap and resume", () => {
  const CONNECTED = {
    desired: true,
    network: "online",
    phase: "connected",
    stage: null,
    attempt: 1,
    generation: 1,
    lastFailure: null,
    retryAt: null,
  } as const;

  const capThread = (id: string, overrides: Record<string, unknown> = {}) => ({
    id: ThreadId.make(id),
    projectId: CACHED_PROJECT.id,
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  });

  const CACHED: OrchestrationShellSnapshot = {
    snapshotSequence: 9,
    projects: [CACHED_PROJECT],
    threads: [
      capThread("working", {
        lastActivityAt: "2026-06-01T00:00:00.000Z",
        lastActivityAgeMs: 1_000,
      }),
    ],
    updatedAt: "2026-06-01T00:00:00.000Z",
    capped: true,
    revision: "cached-revision",
  };

  /** A shell over one session whose subscribeShell records its inputs and replays `items`. */
  const setup = (cached: OrchestrationShellSnapshot | null) =>
    Effect.gen(function* () {
      const items = yield* Queue.unbounded<OrchestrationShellStreamItem>();
      const inputs: unknown[] = [];
      const firstSession = session({
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (input: unknown) => {
          inputs.push(input);
          return Stream.fromQueue(items);
        },
      } as unknown as WsRpcProtocolClient);
      const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
        Option.some(firstSession),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: supervisorState,
        session: activeSession,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.fromNullishOr(cached)),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        clear: () => Effect.void,
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
      );
      yield* SubscriptionRef.set(supervisorState, CONNECTED);
      yield* yieldForShell;
      const live = SubscriptionRef.changes(shellState).pipe(
        Stream.filter((state) => state.status === "live"),
        Stream.runHead,
      );
      return { items, inputs, shellState, activeSession, live } as const;
    });

  it.effect("subscribes with the cap, the include set and the cached revision", () =>
    Effect.gen(function* () {
      setShellIncludeHints(() => [ThreadId.make("pinned")]);
      const { inputs } = yield* setup(CACHED);
      setShellIncludeHints(() => []);
      expect(inputs).toEqual([
        {
          cap: { include: ["pinned"] },
          resume: { revision: "cached-revision", snapshotSequence: 9 },
        },
      ]);
    }),
  );

  it.effect("takes unchanged as live and pins its activity ages", () =>
    Effect.gen(function* () {
      const { items, shellState, live } = yield* setup(CACHED);
      yield* TestClock.setTime(50_000);
      yield* Queue.offer(items, {
        kind: "unchanged",
        snapshotSequence: 9,
        revision: "cached-revision",
        activityAges: { [ThreadId.make("working")]: 4_000 },
      });
      yield* live;
      const snapshot = Option.getOrThrow((yield* SubscriptionRef.get(shellState)).snapshot);
      expect(snapshot.revision).toBe("cached-revision");
      expect(snapshot.capped).toBe(true);
      expect(snapshot.threads[0]).toMatchObject({
        lastActivityAgeMs: 4_000,
        lastActivityObservedAt: 46_000,
      });
    }),
  );

  it.effect("a cold resume after an hour shows No update, not Working", () =>
    Effect.gen(function* () {
      // The cache says one second old; the server says an hour.
      const { items, shellState, live } = yield* setup(CACHED);
      const now = 10 * 3_600_000;
      yield* TestClock.setTime(now);
      yield* Queue.offer(items, {
        kind: "unchanged",
        snapshotSequence: 9,
        revision: "cached-revision",
        activityAges: { [ThreadId.make("working")]: 3_600_000 },
      });
      yield* live;
      const thread = Option.getOrThrow((yield* SubscriptionRef.get(shellState)).snapshot)
        .threads[0]!;
      // The freshness reader ages it from receipt: past the 30-minute No update line.
      expect(threadActivityAgeMs(thread, now)).toBe(3_600_000);
      expect(threadActivityAgeMs(thread, now)! > 30 * 60_000).toBe(true);
    }),
  );

  it.effect("clears the revision on an item without one", () =>
    Effect.gen(function* () {
      const { items, shellState, live } = yield* setup(null);
      const { revision: _none, ...uncached } = CACHED;
      yield* Queue.offer(items, { kind: "snapshot", snapshot: uncached, revision: "first" });
      yield* live;
      expect(Option.getOrThrow((yield* SubscriptionRef.get(shellState)).snapshot).revision).toBe(
        "first",
      );
      yield* Queue.offer(items, {
        kind: "thread-removed",
        sequence: 10,
        threadId: ThreadId.make("working"),
      });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter(
          (state) => Option.isSome(state.snapshot) && state.snapshot.value.snapshotSequence === 10,
        ),
        Stream.runHead,
      );
      expect(
        Option.getOrThrow((yield* SubscriptionRef.get(shellState)).snapshot).revision,
      ).toBeUndefined();
    }),
  );

  it.effect("keeps the engine sequence an item past it carries, and resumes from it", () =>
    Effect.gen(function* () {
      const { items, shellState, live } = yield* setup(null);
      const { revision: _none, ...uncached } = CACHED;
      yield* Queue.offer(items, { kind: "snapshot", snapshot: uncached, revision: "first" });
      yield* live;
      const atSequence = (sequence: number) =>
        SubscriptionRef.changes(shellState).pipe(
          Stream.filter(
            (state) =>
              Option.isSome(state.snapshot) && state.snapshot.value.snapshotSequence === sequence,
          ),
          Stream.runHead,
        );
      // A terminal's agent started working: no event, so the item runs past the engine.
      yield* Queue.offer(items, {
        kind: "thread-upserted",
        sequence: 10,
        engineSequence: 9,
        revision: "past",
        thread: capThread("host"),
      });
      yield* atSequence(10);
      const past = Option.getOrThrow((yield* SubscriptionRef.get(shellState)).snapshot);
      expect(past.engineSequence).toBe(9);
      expect(shellSubscribeInput(TARGET.environmentId, past).resume).toEqual({
        revision: "past",
        snapshotSequence: 9,
      });
      yield* Queue.offer(items, {
        kind: "thread-removed",
        sequence: 11,
        threadId: ThreadId.make("host"),
      });
      yield* atSequence(11);
      expect(
        Option.getOrThrow((yield* SubscriptionRef.get(shellState)).snapshot).engineSequence,
      ).toBeUndefined();
    }),
  );

  it.effect("a new session clears the off-shell store, missing included", () =>
    Effect.gen(function* () {
      const { activeSession } = yield* setup(CACHED);
      offShellThreads.applyLookup(
        TARGET.environmentId,
        offShellThreads.get(TARGET.environmentId).generation,
        { threads: [], missing: [ThreadId.make("restored-later")] },
      );
      expect(offShellThreads.get(TARGET.environmentId).missing.size).toBe(1);
      yield* SubscriptionRef.set(
        activeSession,
        Option.some(session({} as unknown as WsRpcProtocolClient)),
      );
      yield* yieldForShell;
      expect(offShellThreads.get(TARGET.environmentId).missing.size).toBe(0);
    }),
  );

  it.effect("ignores unchanged from a stale session", () =>
    Effect.gen(function* () {
      const { items, shellState, activeSession } = yield* setup(CACHED);
      const before = yield* SubscriptionRef.get(shellState);
      yield* SubscriptionRef.set(
        activeSession,
        Option.some(session({} as unknown as WsRpcProtocolClient)),
      );
      yield* yieldForShell;
      yield* Queue.offer(items, {
        kind: "unchanged",
        snapshotSequence: 9,
        revision: "cached-revision",
        activityAges: {},
      });
      yield* yieldForShell;
      const after = yield* SubscriptionRef.get(shellState);
      expect(after.status).not.toBe("live");
      expect(Option.getOrThrow(after.snapshot)).toBe(Option.getOrThrow(before.snapshot));
    }),
  );
});
