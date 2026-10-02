import {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  type ServerConfig,
} from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { BearerConnectionProfile, type ConnectionCatalogEntry } from "../connection/catalog.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  fileContentCatalogKey,
  readFileTransferSession,
  sameFileContentIdentity,
} from "./fileTransferSession.ts";

const decodeEnvironmentDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
const target = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("client-host"),
  connectionId: "saved-host",
  serverEnvironmentId: EnvironmentId.make("server-host"),
  label: "Host",
});
const profile = new BearerConnectionProfile({
  environmentId: target.environmentId,
  connectionId: target.connectionId,
  label: target.label,
  httpBaseUrl: "https://host.invalid/",
  wsBaseUrl: "wss://host.invalid/",
  hostKey: "pin",
});
const config = (storageInstanceId: string | null = "store"): ServerConfig =>
  ({
    environment: decodeEnvironmentDescriptor({
      environmentId: "server-host",
      label: "Host",
      serverVersion: "test",
      platform: { os: "linux", arch: "x64" },
      storageInstanceId,
      capabilities: { inChannelTransfers: true },
    }),
  }) as ServerConfig;
const session = (
  initialConfig: RpcSession["initialConfig"] = Effect.succeed(config()),
): RpcSession => ({
  client: {} as RpcSession["client"],
  initialConfig,
  ready: Effect.void,
  probe: Effect.void,
  closed: Effect.never,
  e2eeAuthenticated: Effect.succeed(null),
});
const prepared = (): PreparedConnection => ({
  target,
  environmentId: target.environmentId,
  label: "Host",
  descriptor: config().environment,
  httpBaseUrl: profile.httpBaseUrl,
  socketUrl: "wss://host.invalid/ws-e2ee",
  httpAuthorization: null,
  e2ee: { hostKey: "pin", auth: { kind: "bearer", credential: "fixture" } },
});
const harness = Effect.fn(function* (carrying = session()) {
  let lifetime: object = {};
  const supervisor = EnvironmentSupervisor.of({
    target,
    session: yield* SubscriptionRef.make(Option.some(carrying)),
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected",
      desired: true,
      generation: 1,
    }),
    prepared: yield* SubscriptionRef.make(Option.some(prepared())),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  let current = supervisor;
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map([[target.environmentId, { target, profile: Option.some(profile) }]]),
  );
  const fixture: Pick<EnvironmentRegistry["Service"], "entries" | "registrationLifetime" | "run"> =
    {
      entries,
      registrationLifetime: () => Effect.sync(() => lifetime),
      run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, current),
    };
  const registry = fixture as EnvironmentRegistry["Service"];
  return {
    supervisor,
    registry,
    carrying,
    replaceLifetime: () => {
      lifetime = {};
    },
    replace: (value: typeof supervisor) => {
      current = value;
    },
  };
});

describe("file transfer carrying session", () => {
  it("rejects malformed endpoint authority while preserving valid URL normalization", () => {
    const original = { target, profile: Option.some(profile) };
    const normalized = {
      target,
      profile: Option.some(
        new BearerConnectionProfile({
          ...profile,
          httpBaseUrl: "https://fixture:credential@HOST.INVALID:443/",
          wsBaseUrl: "wss://HOST.INVALID:443/",
        }),
      ),
    };
    expect(fileContentCatalogKey(normalized)).toBe(fileContentCatalogKey(original));
    for (const value of [
      "malformed-endpoint-fixture",
      "javascript:invalid",
      "file:///tmp/fixture",
    ]) {
      expect(
        fileContentCatalogKey({
          target,
          profile: Option.some(new BearerConnectionProfile({ ...profile, httpBaseUrl: value })),
        }),
      ).toBeNull();
    }
    expect(
      fileContentCatalogKey({
        target,
        profile: Option.some(
          new BearerConnectionProfile({ ...profile, wsBaseUrl: "not-a-socket-url" }),
        ),
      }),
    ).toBeNull();
  });
  it.effect(
    "captures the config, prepared route and accepted store from one connected session",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const result = yield* readFileTransferSession(h.registry, h.supervisor, h.carrying);
        expect(result.session).toBe(h.carrying);
        expect(result.config.environment.storageInstanceId).toBe("store");
        expect(result.identity.sessionBoundary).toBeNull();
        expect(result.generation).toBe(1);
        yield* SubscriptionRef.set(h.supervisor.prepared, Option.none());
        expect(
          Exit.isFailure(
            yield* Effect.exit(readFileTransferSession(h.registry, h.supervisor, h.carrying)),
          ),
        ).toBe(true);
      }),
  );

  for (const change of [
    "session",
    "supervisor",
    "generation",
    "prepared",
    "removed",
    "retarget",
    "registration",
  ] as const) {
    it.effect(`refuses ${change} replacement while cached config is pending`, () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<ServerConfig>();
        const carrying = session(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate))),
        );
        const h = yield* harness(carrying);
        const pending = yield* readFileTransferSession(h.registry, h.supervisor, carrying).pipe(
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        switch (change) {
          case "registration":
            h.replaceLifetime();
            break;
          case "session":
            yield* SubscriptionRef.set(h.supervisor.session, Option.some(session()));
            break;
          case "supervisor":
            h.replace((yield* harness()).supervisor);
            break;
          case "generation":
            yield* SubscriptionRef.update(h.supervisor.state, (value) => ({
              ...value,
              generation: 2,
            }));
            break;
          case "prepared":
            yield* SubscriptionRef.set(h.supervisor.prepared, Option.some(prepared()));
            break;
          case "removed":
            yield* SubscriptionRef.set(h.registry.entries, new Map());
            break;
          case "retarget":
            yield* SubscriptionRef.set(
              h.registry.entries,
              new Map([
                [
                  target.environmentId,
                  {
                    target,
                    profile: Option.some(
                      new BearerConnectionProfile({ ...profile, hostKey: "other" }),
                    ),
                  },
                ],
              ]),
            );
            break;
        }
        yield* Deferred.succeed(gate, config());
        expect(Exit.isFailure(yield* Fiber.await(pending))).toBe(true);
      }),
    );
  }

  it.effect(
    "preserves identity across labels and credentials but separates host and store changes",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const first = yield* readFileTransferSession(h.registry, h.supervisor, h.carrying);
        yield* SubscriptionRef.set(
          h.registry.entries,
          new Map([
            [
              target.environmentId,
              {
                target: new BearerConnectionTarget({ ...target, label: "Renamed" }),
                profile: Option.some(new BearerConnectionProfile({ ...profile, label: "Renamed" })),
              },
            ],
          ]),
        );
        const rotated = session();
        yield* SubscriptionRef.set(h.supervisor.session, Option.some(rotated));
        yield* SubscriptionRef.set(
          h.supervisor.prepared,
          Option.some({
            ...prepared(),
            e2ee: { hostKey: "pin", auth: { kind: "bearer", credential: "rotated" } },
          }),
        );
        const next = yield* readFileTransferSession(h.registry, h.supervisor, rotated);
        expect(sameFileContentIdentity(first.identity, next.identity)).toBe(true);
        const otherStore = session(Effect.succeed(config("other-store")));
        yield* SubscriptionRef.set(h.supervisor.session, Option.some(otherStore));
        expect(
          sameFileContentIdentity(
            first.identity,
            (yield* readFileTransferSession(h.registry, h.supervisor, otherStore)).identity,
          ),
        ).toBe(false);
        yield* SubscriptionRef.set(
          h.registry.entries,
          new Map([
            [
              target.environmentId,
              {
                target,
                profile: Option.some(
                  new BearerConnectionProfile({
                    ...profile,
                    httpBaseUrl: "https://other.invalid/",
                  }),
                ),
              },
            ],
          ]),
        );
        yield* SubscriptionRef.set(
          h.supervisor.prepared,
          Option.some({ ...prepared(), httpBaseUrl: "https://other.invalid/" }),
        );
        yield* SubscriptionRef.set(h.supervisor.session, Option.some(h.carrying));
        expect(
          sameFileContentIdentity(
            first.identity,
            (yield* readFileTransferSession(h.registry, h.supervisor, h.carrying)).identity,
          ),
        ).toBe(false);
      }),
  );

  it.effect(
    "never infers store continuity across sessions when the server omits its store identity",
    () =>
      Effect.gen(function* () {
        const first = session(Effect.succeed(config(null)));
        const h = yield* harness(first);
        const a = yield* readFileTransferSession(h.registry, h.supervisor, first);
        expect(a.identity.sessionBoundary).toBe(first);
        expect(
          sameFileContentIdentity(
            a.identity,
            (yield* readFileTransferSession(h.registry, h.supervisor, first)).identity,
          ),
        ).toBe(true);
        const second = session(Effect.succeed(config(null)));
        yield* SubscriptionRef.set(h.supervisor.session, Option.some(second));
        expect(
          sameFileContentIdentity(
            a.identity,
            (yield* readFileTransferSession(h.registry, h.supervisor, second)).identity,
          ),
        ).toBe(false);
      }),
  );
});
