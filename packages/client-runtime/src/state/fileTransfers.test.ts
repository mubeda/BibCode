import {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  WS_METHODS,
  type ServerConfig,
} from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
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
import { EnvironmentNotRegisteredError, EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { FileTransferClientError, type DownloadSink } from "../operations/fileTransfers.ts";
import { createFileTransferEnvironmentAtoms, type DownloadResult } from "./fileTransfers.ts";

const host = EnvironmentId.make("host");
const other = EnvironmentId.make("other");
const decodeDescriptor = Schema.decodeEffect(ExecutionEnvironmentDescriptor);
const makeHarness = Effect.fn(function* (
  serviceGate: Effect.Effect<void> = Effect.void,
  lifetimeLookup?: (id: EnvironmentId) => Effect.Effect<object, EnvironmentNotRegisteredError>,
) {
  let lifetime: object = {};
  let reads = 0;
  const supervisors = new Map<EnvironmentId, EnvironmentSupervisor["Service"]>();
  const catalog = new Map<EnvironmentId, ConnectionCatalogEntry>();
  for (const environmentId of [host, other]) {
    const target = new PrimaryConnectionTarget({
      environmentId,
      label: environmentId,
      httpBaseUrl: `https://${environmentId}.invalid`,
      wsBaseUrl: `wss://${environmentId}.invalid`,
    });
    const descriptor = yield* decodeDescriptor({
      environmentId,
      label: environmentId,
      serverVersion: "test",
      platform: { os: "linux", arch: "x64" },
      storageInstanceId: environmentId,
      capabilities: { inChannelTransfers: true },
    });
    const session: RpcSession = {
      client: {
        [WS_METHODS.projectsReadDownload]: () => {
          reads += 1;
          return Stream.make(
            {
              _tag: "start",
              kind: "file",
              fileName: "empty.txt",
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
      label: environmentId,
      descriptor,
      httpBaseUrl: target.httpBaseUrl,
      socketUrl: `${target.wsBaseUrl}/ws-e2ee`,
      httpAuthorization: null,
      e2ee: { hostKey: environmentId, auth: { kind: "bearer", credential: "fixture" } },
    };
    const supervisor = EnvironmentSupervisor.of({
      target,
      state: yield* SubscriptionRef.make<SupervisorConnectionState>({
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        phase: "connected",
      }),
      session: yield* SubscriptionRef.make(Option.some(session)),
      prepared: yield* SubscriptionRef.make(Option.some(prepared)),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
    supervisors.set(environmentId, supervisor);
    catalog.set(environmentId, { target, profile: Option.none() });
  }
  const entries =
    yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(catalog);
  const fixture: Pick<
    EnvironmentRegistry["Service"],
    "entries" | "registrationLifetime" | "run" | "followStream"
  > = {
    entries,
    registrationLifetime: (id) => lifetimeLookup?.(id) ?? Effect.sync(() => lifetime),
    run: <A, E, R>(
      environmentId: EnvironmentId,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | EnvironmentNotRegisteredError, Exclude<R, EnvironmentSupervisor>> =>
      Effect.suspend<A, E | EnvironmentNotRegisteredError, Exclude<R, EnvironmentSupervisor>>(
        () => {
          const supervisor = supervisors.get(environmentId);
          return supervisor === undefined
            ? Effect.fail(new EnvironmentNotRegisteredError({ environmentId }))
            : Effect.provideService(effect, EnvironmentSupervisor, supervisor);
        },
      ),
    followStream: (environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor, supervisors.get(environmentId)!),
  };
  const registry = fixture as EnvironmentRegistry["Service"];
  const atoms = createFileTransferEnvironmentAtoms(
    Atom.runtime(Layer.effect(EnvironmentRegistry, serviceGate.pipe(Effect.as(registry)))),
  );
  const atomRegistry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => atomRegistry.dispose()));
  return {
    atoms,
    atomRegistry,
    registry,
    reads: () => reads,
    catalog,
    replaceLifetime: () => {
      lifetime = {};
    },
  };
});
const nativeSink = (
  overrides: Partial<DownloadSink<DownloadResult>> = {},
): DownloadSink<DownloadResult> => ({
  start: () => Effect.void,
  write: () => Effect.void,
  reset: () => Effect.void,
  finish: () => Effect.succeed({ path: "/fixture/empty.txt" }),
  abort: () => Effect.void,
  ...overrides,
});
const request = (sink = nativeSink(), environmentId = host) => ({
  environmentId,
  input: { cwd: "/repo", relativePath: "empty.txt", sink },
});
async function runDownload(
  h: Effect.Success<ReturnType<typeof makeHarness>>,
  value: ReturnType<typeof request>,
  options?: { readonly signal?: AbortSignal },
) {
  const prepared = await h.atoms.prepareDownload.run(
    h.atomRegistry,
    {
      environmentId: value.environmentId,
      cwd: value.input.cwd,
      relativePath: value.input.relativePath,
    },
    options,
  );
  if (prepared._tag === "Failure") return AsyncResult.failure(prepared.cause);
  return h.atoms.download.run(
    h.atomRegistry,
    { environmentId: value.environmentId, admission: prepared.value, sink: value.input.sink },
    options,
  );
}

const waitFor = (predicate: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die("Expected file operation state was not published");
  });

describe("environment-owned file transfers", () => {
  it.effect(
    "preserves a fresh re-added registration's intent while an old removal observer resumes",
    () =>
      Effect.gen(function* () {
        const lifetimes = new Map<EnvironmentId, object>([
          [host, {}],
          [other, {}],
        ]);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
        let armed = false;
        let gated = false;
        const h = yield* makeHarness(Effect.void, (id) => {
          const current = Effect.suspend(() => {
            const value = lifetimes.get(id);
            return value === undefined
              ? Effect.fail(new EnvironmentNotRegisteredError({ environmentId: id }))
              : Effect.succeed(value);
          });
          if (id !== other || !armed || gated) return current;
          gated = true;
          return Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(current),
          );
        });
        yield* Effect.promise(() => runDownload(h, request(nativeSink(), other)));
        armed = true;
        lifetimes.delete(host);
        yield* SubscriptionRef.set(h.registry.entries, new Map([[other, h.catalog.get(other)!]]));
        yield* Deferred.await(entered);
        lifetimes.set(host, {});
        yield* SubscriptionRef.set(h.registry.entries, new Map(h.catalog));
        const prepared = yield* Effect.promise(() =>
          h.atoms.prepareDownload.run(h.atomRegistry, {
            environmentId: host,
            cwd: "/repo",
            relativePath: "empty.txt",
          }),
        );
        if (prepared._tag !== "Success")
          return yield* Effect.die("Fresh registration was not admitted");
        expect(h.atomRegistry.get(h.atoms.operation(host))?.phase).toBe("preparing");
        yield* Deferred.succeed(release, undefined);
        for (let i = 0; i < 30; i++) yield* Effect.yieldNow;
        expect(h.atomRegistry.get(h.atoms.operation(host))?.phase).toBe("preparing");
        const result = yield* Effect.promise(() =>
          h.atoms.download.run(h.atomRegistry, {
            environmentId: host,
            admission: prepared.value,
            sink: nativeSink(),
          }),
        );
        expect(result._tag).toBe("Success");
      }),
  );

  it.effect("never admits final publication after cancellation requested inside sink start", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      let finished = 0;
      let aborted = 0;
      const result = yield* Effect.promise(() =>
        runDownload(
          h,
          request(
            nativeSink({
              start: () =>
                Effect.sync(() =>
                  h.atoms.cancel(
                    h.atomRegistry,
                    host,
                    h.atomRegistry.get(h.atoms.operation(host))!.operationId,
                  ),
                ),
              finish: () =>
                Effect.sync(() => {
                  finished += 1;
                  return { path: "/fixture/should-not-publish" };
                }),
              abort: () =>
                Effect.sync(() => {
                  aborted += 1;
                }),
            }),
          ),
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(finished).toBe(0);
      expect(aborted).toBe(1);
    }),
  );
  for (const lateAction of ["cancel", "retarget", "remove"] as const) {
    it.effect(`joins final publication and reports success after a late ${lateAction}`, () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        let settled = false;
        let aborts = 0;
        const pending = runDownload(
          h,
          request(
            nativeSink({
              finish: () =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(gate)),
                  Effect.as({ path: "/fixture/published.txt" }),
                  Effect.uninterruptible,
                ),
              abort: () =>
                Effect.sync(() => {
                  aborts += 1;
                }),
            }),
          ),
        );
        void pending.then(() => {
          settled = true;
        });
        yield* Deferred.await(entered);
        try {
          expect(h.atomRegistry.get(h.atoms.operation(host))?.phase).toBe("finishing");
          if (lateAction === "cancel")
            h.atoms.cancel(
              h.atomRegistry,
              host,
              h.atomRegistry.get(h.atoms.operation(host))!.operationId,
            );
          else {
            h.replaceLifetime();
            yield* SubscriptionRef.set(
              h.registry.entries,
              lateAction === "remove" ? new Map() : new Map(h.catalog),
            );
          }
          yield* Effect.yieldNow;
          expect(settled).toBe(false);
          expect((yield* Effect.promise(() => runDownload(h, request())))._tag).toBe("Failure");
        } finally {
          yield* Deferred.succeed(gate, undefined);
        }
        const result = yield* Effect.promise(() => pending);
        expect(result).toMatchObject({
          _tag: "Success",
          value: { path: "/fixture/published.txt" },
        });
        expect(h.atomRegistry.get(h.atoms.operation(host))?.phase).toBe("saved");
        expect(aborts).toBe(0);
      }),
    );
  }

  it.effect(
    "reports the real finish failure after joined cleanup even if the environment changes",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const entered = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const aborting = yield* Deferred.make<void>();
        const aborted = yield* Deferred.make<void>();
        const failure = new FileTransferClientError({
          reason: "save",
          message: "native finish failed",
        });
        let settled = false;
        const pending = runDownload(
          h,
          request(
            nativeSink({
              finish: () =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(finish)),
                  Effect.andThen(Effect.fail(failure)),
                  Effect.uninterruptible,
                ),
              abort: () =>
                Deferred.succeed(aborting, undefined).pipe(Effect.andThen(Deferred.await(aborted))),
            }),
          ),
        );
        void pending.then(() => {
          settled = true;
        });
        yield* Deferred.await(entered);
        h.replaceLifetime();
        yield* SubscriptionRef.set(h.registry.entries, new Map(h.catalog));
        yield* Deferred.succeed(finish, undefined);
        yield* Deferred.await(aborting);
        try {
          expect(settled).toBe(false);
        } finally {
          yield* Deferred.succeed(aborted, undefined);
        }
        expect(yield* Effect.promise(() => pending)).toMatchObject({
          _tag: "Failure",
          cause: { reasons: [{ error: failure }] },
        });
        expect(h.atomRegistry.get(h.atoms.operation(host))).toMatchObject({
          phase: "failed",
          message: "native finish failed",
        });
      }),
  );
  it.effect("discards a ready result when the same ID has a new registration lifetime", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* Effect.promise(() =>
        runDownload(
          h,
          request(
            nativeSink({ finish: () => Effect.succeed({ fileName: "empty", blob: new Blob([]) }) }),
          ),
        ),
      );
      expect(h.atomRegistry.get(h.atoms.operation(host))?.phase).toBe("ready");
      h.replaceLifetime();
      yield* SubscriptionRef.set(h.registry.entries, new Map(h.catalog));
      yield* waitFor(() => h.atomRegistry.get(h.atoms.operation(host)) === null);
    }),
  );
  it.effect(
    "shares one operation slot across panels while different environments run independently",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const first = runDownload(
          h,
          request(
            nativeSink({
              start: () =>
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate))),
            }),
          ),
        );
        yield* Deferred.await(entered);
        const second = yield* Effect.promise(() => runDownload(h, request()));
        expect(second).toMatchObject({
          _tag: "Failure",
          cause: { reasons: [{ error: { reason: "busy" } }] },
        });
        expect(
          (yield* Effect.promise(() => runDownload(h, request(nativeSink(), other))))._tag,
        ).toBe("Success");
        expect(h.reads()).toBe(2);
        yield* Deferred.succeed(gate, undefined);
        expect((yield* Effect.promise(() => first))._tag).toBe("Success");
      }),
  );

  it.effect("does not release admission when Abort settles before the gated sink cleanup", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const entered = yield* Deferred.make<void>();
      const cleaning = yield* Deferred.make<void>();
      const cleaned = yield* Deferred.make<void>();
      const result = runDownload(
        h,
        request(
          nativeSink({
            start: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
            abort: () =>
              Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(cleaned))),
          }),
        ),
      );
      yield* Deferred.await(entered);
      const state = h.atomRegistry.get(h.atoms.operation(host));
      expect(state?.phase).toBe("running");
      h.atoms.cancel(h.atomRegistry, host, state!.operationId);
      expect((yield* Effect.promise(() => result))._tag).toBe("Failure");
      yield* Deferred.await(cleaning);
      expect(h.atomRegistry.get(h.atoms.operation(host))?.phase).toBe("cancelling");
      const refused = yield* Effect.promise(() => runDownload(h, request()));
      expect(refused).toMatchObject({
        _tag: "Failure",
        cause: { reasons: [{ error: { reason: "busy" } }] },
      });
      yield* Deferred.succeed(cleaned, undefined);
      yield* waitFor(() => h.atomRegistry.get(h.atoms.operation(host)) === null);
      expect((yield* Effect.promise(() => runDownload(h, request())))._tag).toBe("Success");
      expect(h.reads()).toBe(2);
    }),
  );

  it.effect(
    "retains a ready Blob and the busy slot across panel unmount until explicit dismissal",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const result = { fileName: "empty.txt", blob: new Blob([]) };
        const unmount = h.atomRegistry.mount(h.atoms.operation(host));
        expect(
          (yield* Effect.promise(() =>
            runDownload(h, request(nativeSink({ finish: () => Effect.succeed(result) }))),
          ))._tag,
        ).toBe("Success");
        const ready = h.atomRegistry.get(h.atoms.operation(host));
        expect(ready).toMatchObject({ phase: "ready", result });
        unmount();
        yield* Effect.yieldNow;
        expect(h.atomRegistry.get(h.atoms.operation(host))).toBe(ready);
        expect((yield* Effect.promise(() => runDownload(h, request())))._tag).toBe("Failure");
        h.atoms.dismiss(h.atomRegistry, host, ready!.operationId);
        expect(h.atomRegistry.get(h.atoms.operation(host))).toBeNull();
        expect((yield* Effect.promise(() => runDownload(h, request())))._tag).toBe("Success");
      }),
  );

  it.effect("does not cancel a running save when its panel stops observing progress", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const unmount = h.atomRegistry.mount(h.atoms.operation(host));
      const pending = runDownload(
        h,
        request(
          nativeSink({
            start: () =>
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate))),
          }),
        ),
      );
      yield* Deferred.await(entered);
      unmount();
      yield* Effect.yieldNow;
      expect(h.atomRegistry.get(h.atoms.operation(host))?.phase).toBe("running");
      yield* Deferred.succeed(gate, undefined);
      expect((yield* Effect.promise(() => pending))._tag).toBe("Success");
    }),
  );

  it.effect(
    "clears an aborted-before-start invocation and a failed environment lookup without touching the next ID",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const controller = new AbortController();
        controller.abort();
        expect(
          (yield* Effect.promise(() => runDownload(h, request(), { signal: controller.signal })))
            ._tag,
        ).toBe("Failure");
        expect(h.atomRegistry.get(h.atoms.operation(host))).toBeNull();
        expect(h.reads()).toBe(0);
        const missing = EnvironmentId.make("missing");
        expect(
          (yield* Effect.promise(() => runDownload(h, request(nativeSink(), missing))))._tag,
        ).toBe("Failure");
        expect(h.atomRegistry.get(h.atoms.operation(missing))?.phase).not.toBe("running");
        expect((yield* Effect.promise(() => runDownload(h, request())))._tag).toBe("Success");
        const saved = h.atomRegistry.get(h.atoms.operation(host));
        expect(saved?.phase).toBe("saved");
        h.atoms.dismiss(h.atomRegistry, host, saved!.operationId - 1);
        expect(h.atomRegistry.get(h.atoms.operation(host))).toBe(saved);
      }),
  );

  it.effect(
    "environment removal retains ownership through cleanup and discards the removed result",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const entered = yield* Deferred.make<void>();
        const cleaning = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const pending = runDownload(
          h,
          request(
            nativeSink({
              start: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
              abort: () =>
                Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(gate))),
            }),
          ),
        );
        yield* Deferred.await(entered);
        const oldId = h.atomRegistry.get(h.atoms.operation(host))!.operationId;
        yield* SubscriptionRef.set(h.registry.entries, new Map());
        yield* Deferred.await(cleaning);
        yield* SubscriptionRef.set(h.registry.entries, h.catalog);
        expect((yield* Effect.promise(() => runDownload(h, request())))._tag).toBe("Failure");
        yield* Deferred.succeed(gate, undefined);
        yield* Effect.promise(() => pending);
        yield* waitFor(() => h.atomRegistry.get(h.atoms.operation(host)) === null);
        expect((yield* Effect.promise(() => runDownload(h, request())))._tag).toBe("Success");
        expect(h.atomRegistry.get(h.atoms.operation(host))!.operationId).toBeGreaterThan(oldId);
        h.atoms.cancel(h.atomRegistry, host, oldId);
        expect(h.atomRegistry.get(h.atoms.operation(host))?.phase).toBe("saved");
      }),
  );

  it.effect("discards a retained ready Blob when its environment is removed", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const result = { fileName: "empty.txt", blob: new Blob([]) };
      yield* Effect.promise(() =>
        runDownload(h, request(nativeSink({ finish: () => Effect.succeed(result) }))),
      );
      expect(h.atomRegistry.get(h.atoms.operation(host))?.phase).toBe("ready");
      yield* SubscriptionRef.set(h.registry.entries, new Map());
      yield* waitFor(() => h.atomRegistry.get(h.atoms.operation(host)) === null);
    }),
  );

  it.effect(
    "cancels before runtime admission and fences the late old invocation from a new one",
    () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const h = yield* makeHarness(Deferred.await(gate));
        const first = runDownload(h, request());
        const oldId = h.atomRegistry.get(h.atoms.operation(host))!.operationId;
        h.atoms.cancel(h.atomRegistry, host, oldId);
        expect((yield* Effect.promise(() => first))._tag).toBe("Failure");
        expect(h.atomRegistry.get(h.atoms.operation(host))).toBeNull();
        const second = runDownload(h, request());
        const newId = h.atomRegistry.get(h.atoms.operation(host))!.operationId;
        expect(newId).toBeGreaterThan(oldId);
        yield* Deferred.succeed(gate, undefined);
        expect((yield* Effect.promise(() => second))._tag).toBe("Success");
        expect(h.reads()).toBe(1);
        expect(h.atomRegistry.get(h.atoms.operation(host))?.operationId).toBe(newId);
      }),
  );
});
