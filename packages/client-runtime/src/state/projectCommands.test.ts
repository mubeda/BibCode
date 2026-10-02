import {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  ProjectTransferError,
  WS_METHODS,
  type ProjectCreateUploadUrlInput,
  type ServerConfig,
} from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createProjectEnvironmentAtoms } from "./projectCommands.ts";

const environmentId = EnvironmentId.make("upload-mint");
const input: ProjectCreateUploadUrlInput = {
  cwd: "/fixture",
  relativeDirectory: "",
  fileName: "file.txt",
};
const minted = {
  relativeUrl: "/api/transfers/fixture-upload",
  expiresAt: 9_999_999_999_999,
  maxBytes: 1234,
};
const decodeDescriptor = Schema.decodeEffect(ExecutionEnvironmentDescriptor);
const crypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, bytes) => Effect.succeed(bytes),
  }),
);
const harness = Effect.fn(function* (
  pinned = false,
  capable = false,
  base = "https://fixture.invalid",
) {
  const calls: Array<ProjectCreateUploadUrlInput> = [];
  let configReads = 0;
  let configGate: Effect.Effect<void> = Effect.void;
  let mintFailure: ProjectTransferError | null = null;
  const target = new PrimaryConnectionTarget({
    environmentId,
    label: "Fixture",
    httpBaseUrl: base,
    wsBaseUrl: base.replace(/^http/, "ws"),
  });
  const descriptor = yield* decodeDescriptor({
    environmentId,
    label: "Fixture",
    serverVersion: "test",
    platform: { os: "linux", arch: "x64" },
    storageInstanceId: "store",
    capabilities: { inChannelTransfers: capable },
  });
  const session: RpcSession = {
    client: {
      [WS_METHODS.projectsCreateUploadUrl]: (value: ProjectCreateUploadUrlInput) =>
        Effect.suspend(() => {
          calls.push(value);
          return mintFailure === null ? Effect.succeed(minted) : Effect.fail(mintFailure);
        }),
    } as unknown as RpcSession["client"],
    initialConfig: Effect.suspend(() => {
      configReads += 1;
      return configGate.pipe(Effect.as({ environment: descriptor } as ServerConfig));
    }),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
    e2eeAuthenticated: Effect.succeed(null),
  };
  const pin = { hostKey: "fixture-pin", auth: { kind: "bearer" as const, credential: "fixture" } };
  const prepared: PreparedConnection = {
    target,
    environmentId,
    label: target.label,
    descriptor,
    httpBaseUrl: base,
    socketUrl: `${target.wsBaseUrl}/ws`,
    httpAuthorization: null,
    e2ee: pinned ? pin : null,
  };
  const supervisor = EnvironmentSupervisor.of({
    target,
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.some(prepared)),
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      phase: "connected",
    }),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const lifetime = {};
  const fixture: Pick<EnvironmentRegistry["Service"], "entries" | "registrationLifetime" | "run"> =
    {
      entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
        new Map([[environmentId, { target, profile: Option.none() }]]),
      ),
      registrationLifetime: () => Effect.succeed(lifetime),
      run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
    };
  const atoms = createProjectEnvironmentAtoms(
    Atom.runtime(
      Layer.merge(
        crypto,
        Layer.succeed(EnvironmentRegistry, fixture as EnvironmentRegistry["Service"]),
      ),
    ),
  );
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return {
    calls,
    configReads: () => configReads,
    setConfigGate: (value: Effect.Effect<void>) => {
      configGate = value;
    },
    setFailure: (value: ProjectTransferError) => {
      mintFailure = value;
    },
    pin: SubscriptionRef.set(supervisor.prepared, Option.some({ ...prepared, e2ee: pin })),
    missing: SubscriptionRef.set(supervisor.prepared, Option.none()),
    run: () => Effect.promise(() => atoms.createUploadUrl.run(registry, { environmentId, input })),
  };
});

describe("legacy workspace upload URL command", () => {
  for (const base of ["http://fixture.invalid", "https://fixture.invalid"])
    for (const capable of [false, true]) {
      it.effect(`refuses every pinned ${base} session with capability ${capable}`, () =>
        Effect.gen(function* () {
          const h = yield* harness(true, capable, base);
          expect((yield* h.run())._tag).toBe("Failure");
          expect(h.calls).toEqual([]);
        }),
      );
    }
  it.effect("preserves the existing unpinned result and exact input", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      expect(yield* h.run()).toMatchObject({ _tag: "Success", value: minted });
      expect(h.calls).toEqual([input]);
    }),
  );
  it.effect("preserves a declared unpinned server refusal", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const failure = new ProjectTransferError({
        cwd: input.cwd,
        relativePath: input.fileName,
        failure: "operation_failed",
        message: "Fixture refusal",
      });
      h.setFailure(failure);
      expect(yield* h.run()).toMatchObject({
        _tag: "Failure",
        cause: { reasons: [{ error: failure }] },
      });
      expect(h.calls).toEqual([input]);
    }),
  );
  it.effect("refuses a missing prepared context before mint", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.missing;
      expect((yield* h.run())._tag).toBe("Failure");
      expect(h.calls).toEqual([]);
    }),
  );
  it.effect("rechecks a pin transition while carrying-session config is pending", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const release = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
      h.setConfigGate(Deferred.await(release));
      const pending = yield* Effect.forkChild(h.run());
      for (let i = 0; i < 100 && h.configReads() === 0; i++) yield* Effect.yieldNow;
      expect(h.configReads()).toBe(1);
      yield* h.pin;
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(pending);
      expect(result._tag).toBe("Failure");
      expect(h.calls).toEqual([]);
    }),
  );
});
