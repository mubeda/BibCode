import {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  WS_METHODS,
  type ServerConfig,
} from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import {
  PrimaryConnectionTarget,
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createFileTransferEnvironmentAtoms, type DownloadResult } from "../state/fileTransfers.ts";
import type { DownloadSink } from "./fileTransfers.ts";
import type { FileDownloadAdmission } from "./fileDownloadAdmission.ts";

const environmentId = EnvironmentId.make("admission-host");
const decodeDescriptor = Schema.decodeEffect(ExecutionEnvironmentDescriptor);
const path = { cwd: "/original/workspace", relativePath: "original.txt" };
const harness = Effect.fn(function* (
  initialPinned = false,
  initialStore: string | null = "store",
  initialCapable = true,
) {
  let pinned = initialPinned;
  let store = initialStore;
  let capable = initialCapable;
  let lifetime: object = {};
  let serial = 0;
  let begins = 0;
  let baseUrl = "https://original.invalid";
  let label = "Original host";
  let onMint: Effect.Effect<void> = Effect.void;
  let relativeUrl: string | null = null;
  const calls: Array<{
    readonly method: "mint" | "read";
    readonly session: number;
    readonly input: unknown;
  }> = [];
  const makeSupervisor = Effect.fn(function* () {
    const number = ++serial;
    const target = new PrimaryConnectionTarget({
      environmentId,
      label,
      httpBaseUrl: baseUrl,
      wsBaseUrl: baseUrl.replace(/^http/, "ws"),
    });
    const descriptor = yield* decodeDescriptor({
      environmentId,
      label,
      serverVersion: "test",
      platform: { os: "linux", arch: "x64" },
      storageInstanceId: store,
      capabilities: { inChannelTransfers: capable },
    });
    const session: RpcSession = {
      client: {
        [WS_METHODS.projectsCreateDownloadUrl]: (input: unknown) =>
          Effect.sync(() => {
            calls.push({ method: "mint", session: number, input });
          }).pipe(
            Effect.andThen(Effect.suspend(() => onMint)),
            Effect.map(() => ({
              relativeUrl: relativeUrl ?? `/api/transfers/fixture-${number}`,
              fileName: "original.txt",
              kind: "file",
              expiresAt: 9999999999999,
            })),
          ),
        [WS_METHODS.projectsReadDownload]: (input: unknown) => {
          calls.push({ method: "read", session: number, input });
          return Stream.make(
            {
              _tag: "start",
              kind: "file",
              fileName: "original.txt",
              sizeBytes: 0,
              version: { sizeBytes: 0, modifiedAtNs: "1" },
            },
            { _tag: "end", totalBytes: 0 },
          );
        },
      } as unknown as RpcSession["client"],
      initialConfig: Effect.succeed({ environment: descriptor } as ServerConfig),
      ready: Effect.void,
      probe: Effect.void,
      closed: Effect.never,
      e2eeAuthenticated: Effect.succeed(null),
    };
    const prepared: PreparedConnection = {
      target,
      environmentId,
      label,
      descriptor,
      httpBaseUrl: baseUrl,
      socketUrl: `${target.wsBaseUrl}/ws`,
      httpAuthorization: null,
      e2ee: pinned
        ? { hostKey: "fixture-pin", auth: { kind: "bearer", credential: `fixture-${number}` } }
        : null,
    };
    return EnvironmentSupervisor.of({
      target,
      session: yield* SubscriptionRef.make(Option.some(session)),
      prepared: yield* SubscriptionRef.make(Option.some(prepared)),
      state: yield* SubscriptionRef.make<SupervisorConnectionState>({
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        phase: "connected",
        generation: number,
      }),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
  });
  let supervisor = yield* makeSupervisor();
  const supervisors = yield* SubscriptionRef.make(supervisor);
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map([[environmentId, { target: supervisor.target, profile: Option.none() }]]),
  );
  const fixture: Pick<
    EnvironmentRegistry["Service"],
    "entries" | "registrationLifetime" | "run" | "followStream"
  > = {
    entries,
    registrationLifetime: () => Effect.sync(() => lifetime),
    run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
    followStream: (_id, stream) =>
      SubscriptionRef.changes(supervisors).pipe(
        Stream.switchMap((current) =>
          Stream.provideService(stream, EnvironmentSupervisor, current),
        ),
      ),
  };
  const registry = fixture as EnvironmentRegistry["Service"];
  const runtimeFailure = Atom.make(false);
  const runtime = Atom.runtime((get) =>
    get(runtimeFailure)
      ? Layer.effect(EnvironmentRegistry, Effect.fail("runtime fixture unavailable"))
      : Layer.succeed(EnvironmentRegistry, registry),
  );
  const atoms = createFileTransferEnvironmentAtoms(runtime);
  const atomRegistry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => atomRegistry.dispose()));
  const sink: DownloadSink<DownloadResult> = {
    start: () =>
      Effect.sync(() => {
        begins += 1;
      }),
    write: () => Effect.void,
    reset: () => Effect.void,
    finish: () => Effect.succeed({ path: "/fixture/saved.txt" }),
    abort: () => Effect.void,
  };
  const change = (
    options: {
      readonly pinned?: boolean;
      readonly capable?: boolean;
      readonly store?: string | null;
      readonly baseUrl?: string;
      readonly label?: string;
      readonly newLifetime?: boolean;
    } = {},
  ) =>
    Effect.gen(function* () {
      pinned = options.pinned ?? pinned;
      capable = options.capable ?? capable;
      if ("store" in options) store = options.store!;
      baseUrl = options.baseUrl ?? baseUrl;
      label = options.label ?? label;
      if (options.newLifetime) lifetime = {};
      supervisor = yield* makeSupervisor();
      yield* SubscriptionRef.set(supervisors, supervisor);
      yield* SubscriptionRef.set(
        entries,
        new Map([[environmentId, { target: supervisor.target, profile: Option.none() }]]),
      );
    });
  return {
    atoms,
    atomRegistry,
    sink,
    calls,
    begins: () => begins,
    change,
    disconnect: () =>
      SubscriptionRef.update(supervisor.state, (state) => ({
        ...state,
        phase: "available" as const,
      })),
    failRuntime: (failed: boolean) => atomRegistry.set(runtimeFailure, failed),
    runtimeState: () => atomRegistry.get(runtime),
    setRelativeUrl: (value: string) => {
      relativeUrl = value;
    },
    setMint: (effect: Effect.Effect<void>) => {
      onMint = effect;
    },
    prepare: () =>
      Effect.promise(() => atoms.prepareDownload.run(atomRegistry, { environmentId, ...path })),
  };
});
function admission<E>(
  result: AsyncResult.AsyncResult<FileDownloadAdmission, E>,
): FileDownloadAdmission {
  if (!AsyncResult.isSuccess(result)) throw new Error("Expected an admitted fixture download");
  return result.value;
}

describe("prepared download admission", () => {
  for (const [pinned, capable, route] of [
    [false, false, "http"],
    [true, true, "in-channel"],
    [true, false, "unavailable"],
  ] as const) {
    it.effect(`projects ${route} availability without starting a transfer`, () =>
      Effect.gen(function* () {
        const h = yield* harness(pinned, "store", capable);
        const availability = h.atoms.availability(environmentId);
        const unmount = h.atomRegistry.mount(availability);
        yield* Effect.addFinalizer(() => Effect.sync(unmount));
        for (let i = 0; i < 100 && !h.atomRegistry.get(availability).connected; i++)
          yield* Effect.yieldNow;
        expect(h.atomRegistry.get(availability)).toEqual({
          route,
          connected: true,
          serverName: "Original host",
        });
        expect(h.calls).toEqual([]);
        expect(h.begins()).toBe(0);
      }),
    );
  }
  it.effect("fails closed when an available runtime fails or disconnects", () =>
    Effect.gen(function* () {
      const h = yield* harness(true);
      const availability = h.atoms.availability(environmentId);
      const unmount = h.atomRegistry.mount(availability);
      yield* Effect.addFinalizer(() => Effect.sync(unmount));
      for (let i = 0; i < 100 && !h.atomRegistry.get(availability).connected; i++)
        yield* Effect.yieldNow;
      expect(h.atomRegistry.get(availability).route).toBe("in-channel");
      h.failRuntime(true);
      for (let i = 0; i < 100; i++) yield* Effect.yieldNow;
      expect(h.atomRegistry.get(availability)).toMatchObject({
        route: "unavailable",
        connected: false,
      });
      h.failRuntime(false);
      for (let i = 0; i < 100 && !h.atomRegistry.get(availability).connected; i++)
        yield* Effect.yieldNow;
      expect(h.atomRegistry.get(availability).route).toBe("in-channel");
      yield* h.disconnect();
      for (let i = 0; i < 100 && h.atomRegistry.get(availability).connected; i++)
        yield* Effect.yieldNow;
      expect(h.atomRegistry.get(availability)).toMatchObject({
        route: "unavailable",
        connected: false,
      });
      expect(h.calls).toEqual([]);
    }),
  );

  it.effect("never replays an already-failed download when its runtime recovers", () =>
    Effect.gen(function* () {
      const h = yield* harness(true);
      const token = admission(yield* h.prepare());
      h.failRuntime(true);
      for (let i = 0; i < 100 && h.runtimeState()._tag !== "Failure"; i++) yield* Effect.yieldNow;
      expect(h.runtimeState()._tag).toBe("Failure");
      const result = yield* Effect.promise(() =>
        h.atoms.download.run(h.atomRegistry, { environmentId, admission: token, sink: h.sink }),
      );
      expect(result._tag).toBe("Failure");
      h.failRuntime(false);
      for (let i = 0; i < 30; i++) yield* Effect.yieldNow;
      expect(h.calls).toEqual([]);
      expect(h.begins()).toBe(0);
    }),
  );
  it.effect(
    "releases a consumed claim if the runtime fails before the download effect starts",
    () =>
      Effect.gen(function* () {
        const h = yield* harness(true);
        const token = admission(yield* h.prepare());
        h.failRuntime(true);
        for (let i = 0; i < 100 && h.runtimeState()._tag !== "Failure"; i++) yield* Effect.yieldNow;
        expect(h.runtimeState()._tag).toBe("Failure");
        const result = yield* Effect.promise(() =>
          h.atoms.download.run(h.atomRegistry, { environmentId, admission: token, sink: h.sink }),
        );
        expect(result._tag).toBe("Failure");
        expect(h.calls).toEqual([]);
        expect(h.atomRegistry.get(h.atoms.operation(environmentId))?.phase).not.toBe("running");
        h.failRuntime(false);
        const replacement = yield* h.prepare();
        expect(replacement._tag).toBe("Success");
        expect(admission(replacement).operationId).toBeGreaterThan(token.operationId);
        h.atoms.releaseAdmission(h.atomRegistry, environmentId, admission(replacement));
      }),
  );

  it.effect("refuses same-origin URLs outside the existing transfer namespace", () =>
    Effect.gen(function* () {
      const h = yield* harness(false);
      const token = admission(yield* h.prepare());
      h.setRelativeUrl("/api/other-fixture");
      const result = yield* Effect.promise(() =>
        h.atoms.prepareHttpDownload.run(h.atomRegistry, { environmentId, admission: token }),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        cause: { reasons: [{ error: { reason: "protocol" } }] },
      });
    }),
  );
  it.effect("captures only opaque public metadata and keeps original path fields immutable", () =>
    Effect.gen(function* () {
      const h = yield* harness(true);
      const token = admission(yield* h.prepare());
      expect(Object.keys(token).sort()).toEqual(["operationId", "route", "serverName"]);
      expect(Object.isFrozen(token)).toBe(true);
      expect(token.route).toBe("in-channel");
      expect(h.calls).toEqual([]);
      const result = yield* Effect.promise(() =>
        h.atoms.download.run(h.atomRegistry, {
          environmentId,
          admission: token,
          sink: h.sink,
          input: { cwd: "/other", relativePath: "other.txt" },
        } as never),
      );
      expect(result._tag).toBe("Success");
      expect(h.calls).toEqual([{ method: "read", session: 1, input: path }]);
    }),
  );

  it.effect("claims before the picker and releases an unused intent without starting bytes", () =>
    Effect.gen(function* () {
      const h = yield* harness(true);
      const token = admission(yield* h.prepare());
      expect(h.atomRegistry.get(h.atoms.operation(environmentId))).toMatchObject({
        phase: "preparing",
        route: "in-channel",
        cancellable: true,
      });
      expect((yield* h.prepare())._tag).toBe("Failure");
      expect(h.calls).toEqual([]);
      h.atoms.releaseAdmission(h.atomRegistry, environmentId, token);
      expect(h.atomRegistry.get(h.atoms.operation(environmentId))).toBeNull();
      const next = admission(yield* h.prepare());
      expect(next.operationId).toBeGreaterThan(token.operationId);
      h.atoms.releaseAdmission(h.atomRegistry, environmentId, token);
      expect(h.atomRegistry.get(h.atoms.operation(environmentId))?.operationId).toBe(
        next.operationId,
      );
      h.atoms.releaseAdmission(h.atomRegistry, environmentId, next);
    }),
  );

  for (const change of ["target", "pin", "store", "registration"] as const)
    it.effect(`rejects picker-delayed ${change} changes before mint/read/sink begin`, () =>
      Effect.gen(function* () {
        const h = yield* harness(false);
        const token = admission(yield* h.prepare());
        yield* h.change(
          change === "target"
            ? { baseUrl: "https://replacement.invalid" }
            : change === "pin"
              ? { pinned: true }
              : change === "store"
                ? { store: "other-store" }
                : { newLifetime: true },
        );
        const result = yield* Effect.promise(() =>
          h.atoms.prepareHttpDownload.run(h.atomRegistry, { environmentId, admission: token }),
        );
        expect(result._tag).toBe("Failure");
        expect(h.calls).toEqual([]);
        expect(h.begins()).toBe(0);
      }),
    );

  it.effect(
    "allows same-authority reconnect, label and credential changes with a fresh matching HTTP base",
    () =>
      Effect.gen(function* () {
        const h = yield* harness(false);
        const token = admission(yield* h.prepare());
        yield* h.change({ label: "Renamed" });
        const result = yield* Effect.promise(() =>
          h.atoms.prepareHttpDownload.run(h.atomRegistry, { environmentId, admission: token }),
        );
        expect(result).toMatchObject({
          _tag: "Success",
          value: {
            httpBaseUrl: "https://original.invalid",
            url: "https://original.invalid/api/transfers/fixture-2",
          },
        });
        expect(h.calls).toEqual([{ method: "mint", session: 2, input: path }]);
        h.atoms.releaseAdmission(h.atomRegistry, environmentId, token);
      }),
  );

  it.effect("refuses physical session replacement when store continuity cannot be verified", () =>
    Effect.gen(function* () {
      const h = yield* harness(false, null);
      const token = admission(yield* h.prepare());
      yield* h.change();
      expect(
        (yield* Effect.promise(() =>
          h.atoms.prepareHttpDownload.run(h.atomRegistry, { environmentId, admission: token }),
        ))._tag,
      ).toBe("Failure");
      expect(h.calls).toEqual([]);
    }),
  );

  it.effect("checks identity again before publishing a minted HTTP URL", () =>
    Effect.gen(function* () {
      const h = yield* harness(false);
      const token = admission(yield* h.prepare());
      h.setMint(h.change({ baseUrl: "https://replacement.invalid" }).pipe(Effect.orDie));
      expect(
        (yield* Effect.promise(() =>
          h.atoms.prepareHttpDownload.run(h.atomRegistry, { environmentId, admission: token }),
        ))._tag,
      ).toBe("Failure");
      expect(h.calls).toHaveLength(1);
    }),
  );

  it.effect("holds noncancellable legacy HTTP until actual completion is released", () =>
    Effect.gen(function* () {
      const h = yield* harness(false);
      const token = admission(yield* h.prepare());
      expect(
        (yield* Effect.promise(() =>
          h.atoms.prepareHttpDownload.run(h.atomRegistry, { environmentId, admission: token }),
        ))._tag,
      ).toBe("Success");
      let completeNative: () => void = () => {};
      let returned = false;
      const native = new Promise<void>((resolve) => {
        completeNative = resolve;
      }).finally(() => {
        returned = true;
        h.atoms.releaseAdmission(h.atomRegistry, environmentId, token);
      });
      try {
        h.atoms.cancel(h.atomRegistry, environmentId, token.operationId);
        yield* h.change({ newLifetime: true });
        expect(h.atomRegistry.get(h.atoms.operation(environmentId))).toMatchObject({
          phase: "running",
          route: "http",
          cancellable: false,
        });
        expect((yield* h.prepare())._tag).toBe("Failure");
        expect(returned).toBe(false);
      } finally {
        completeNative();
        yield* Effect.promise(() => native);
      }
      expect(h.atomRegistry.get(h.atoms.operation(environmentId))).toBeNull();
    }),
  );

  it.effect(
    "rejects forged, foreign and consumed tokens without clearing a running successor",
    () =>
      Effect.gen(function* () {
        const h = yield* harness(true);
        const token = admission(yield* h.prepare());
        for (const value of [{ ...token } as FileDownloadAdmission, token]) {
          const id = value === token ? EnvironmentId.make("foreign") : environmentId;
          expect(
            (yield* Effect.promise(() =>
              h.atoms.download.run(h.atomRegistry, {
                environmentId: id,
                admission: value,
                sink: h.sink,
              }),
            ))._tag,
          ).toBe("Failure");
        }
        expect(h.calls).toEqual([]);
        expect(
          (yield* Effect.promise(() =>
            h.atoms.download.run(h.atomRegistry, { environmentId, admission: token, sink: h.sink }),
          ))._tag,
        ).toBe("Success");
        expect(
          (yield* Effect.promise(() =>
            h.atoms.download.run(h.atomRegistry, { environmentId, admission: token, sink: h.sink }),
          ))._tag,
        ).toBe("Failure");
        expect(h.calls).toHaveLength(1);
      }),
  );

  it.effect("fails closed before any picker intent when pinned capability is unavailable", () =>
    Effect.gen(function* () {
      const h = yield* harness(true, "store", false);
      expect((yield* h.prepare())._tag).toBe("Failure");
      expect(h.calls).toEqual([]);
      expect(h.atomRegistry.get(h.atoms.operation(environmentId))?.phase).not.toBe("preparing");
    }),
  );
});
