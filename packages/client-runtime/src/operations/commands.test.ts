import {
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ThreadId,
  UpdateMaintenanceActiveError,
  type ClientOrchestrationCommand,
} from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { archiveThread, createProject, stopThreadSession } from "./commands.ts";
import * as EnvironmentCommands from "./commands.ts";

const TEST_CRYPTO_LAYER = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const CONNECTED_CONNECTION_STATE = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online" as const,
  phase: "connected" as const,
  generation: 1,
};

const makeSupervisor = Effect.fn("TestEnvironmentCommands.makeSupervisor")(function* (
  dispatched: ClientOrchestrationCommand[],
  state = CONNECTED_CONNECTION_STATE,
  updateActive = false,
) {
  const client = {
    [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
      updateActive
        ? Effect.fail(
            new UpdateMaintenanceActiveError({
              message:
                "Persistent mutations are temporarily closed while project data is protected.",
            }),
          )
        : Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  return EnvironmentSupervisor.EnvironmentSupervisor.of({
    environment: EnvironmentSupervisor.legacyCatalogEnvironment({
      target: TARGET,
      profile: Option.none(),
    }),
    target: TARGET,
    activeRouteId: yield* SubscriptionRef.make<string | null>(null),
    routeResults: yield* SubscriptionRef.make<
      ReadonlyArray<EnvironmentSupervisor.EnvironmentRouteResult>
    >([]),
    state: yield* SubscriptionRef.make(state),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
});

describe("environment commands", () => {
  it.effect("rejects offline mutations before dispatch and records no deferred command", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched, {
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        network: "offline",
        phase: "offline",
      });

      const error = yield* createProject({
        projectId: ProjectId.make("offline-project"),
        title: "Offline Project",
        workspaceRoot: "/workspace/offline",
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );

      expect(error).toMatchObject({
        _tag: "EnvironmentMutationBlocked",
        reason: "offline",
      });
      expect(dispatched).toEqual([]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("maps the authoritative server maintenance gate to the updating reason", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched, CONNECTED_CONNECTION_STATE, true);

      const error = yield* createProject({
        projectId: ProjectId.make("updating-project"),
        title: "Updating Project",
        workspaceRoot: "/workspace/updating",
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );

      expect(error).toMatchObject({
        _tag: "EnvironmentMutationBlocked",
        reason: "updating",
      });
      expect(dispatched).toEqual([]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("adds generated command metadata", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);

      const result = yield* createProject({
        projectId: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/workspace/project",
        createdAt: "2026-06-06T00:00:00.000Z",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(result).toEqual({ sequence: 1 });
      expect(dispatched).toEqual([
        {
          type: "project.create",
          commandId: "00000000-0000-4000-8000-000000000000",
          projectId: "project-1",
          title: "Project",
          workspaceRoot: "/workspace/project",
          createdAt: "2026-06-06T00:00:00.000Z",
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("preserves atomic Git project creation options", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);

      yield* createProject({
        commandId: CommandId.make("create-git-project"),
        projectId: ProjectId.make("project-git"),
        title: "Git Project",
        workspaceRoot: "/tmp/project-git",
        createWorkspaceRootIfMissing: true,
        initializeGit: true,
        createdAt: "2026-07-17T00:00:00.000Z",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(dispatched[0]).toMatchObject({
        type: "project.create",
        projectId: "project-git",
        createWorkspaceRootIfMissing: true,
        initializeGit: true,
      });
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("preserves caller metadata for idempotent queued commands", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);

      yield* stopThreadSession({
        commandId: CommandId.make("queued-command"),
        threadId: ThreadId.make("thread-1"),
        createdAt: "2026-06-06T00:01:00.000Z",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(dispatched).toEqual([
        {
          type: "thread.session.stop",
          commandId: "queued-command",
          threadId: "thread-1",
          createdAt: "2026-06-06T00:01:00.000Z",
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("does not add timestamps to commands without createdAt", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);

      yield* archiveThread({
        commandId: CommandId.make("archive-command"),
        threadId: ThreadId.make("thread-1"),
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(dispatched).toEqual([
        {
          type: "thread.archive",
          commandId: "archive-command",
          threadId: "thread-1",
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("dispatches a typed turn delivery resolution with command metadata", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);
      const resolveTurnDelivery = (EnvironmentCommands as unknown as Record<string, unknown>)
        .resolveTurnDelivery;

      expect(resolveTurnDelivery).toBeTypeOf("function");
      yield* (
        resolveTurnDelivery as (input: {
          commandId: CommandId;
          threadId: ThreadId;
          messageId: ReturnType<typeof MessageId.make>;
          action: "retry" | "dismiss";
          createdAt: string;
        }) => ReturnType<typeof stopThreadSession>
      )({
        commandId: CommandId.make("resolve-delivery"),
        threadId: ThreadId.make("thread-1"),
        messageId: MessageId.make("message-1"),
        action: "retry",
        createdAt: "2026-08-03T00:00:00.000Z",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(dispatched).toEqual([
        {
          type: "thread.turn-delivery.resolve",
          commandId: "resolve-delivery",
          threadId: "thread-1",
          messageId: "message-1",
          action: "retry",
          createdAt: "2026-08-03T00:00:00.000Z",
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );
});
