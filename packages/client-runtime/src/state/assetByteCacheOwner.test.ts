import {
  EnvironmentId,
  AssetTooLargeError,
  ExecutionEnvironmentDescriptor,
  WS_METHODS,
  type AssetReadEvent,
  type ServerConfig,
} from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Scheduler from "effect/Scheduler";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/unstable/rpc";
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
import type { AssetReadFailure } from "./assetByteCache.ts";
import {
  makeAssetByteCacheOwner,
  type AssetContentView,
  type AssetByteCacheOwner,
} from "./assetByteCacheOwner.ts";

const decodeEnvironmentDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
const environmentId = EnvironmentId.make("host");
const resource = { _tag: "attachment" as const, attachmentId: "image" };
const events: AssetReadEvent[] = [
  { _tag: "start", mimeType: "image/png", sizeBytes: 3 },
  { _tag: "bytes", offset: 0, data: "YWJj" },
  { _tag: "end" },
];
const transport = new RpcClientError.RpcClientError({
  reason: new RpcClientError.RpcClientDefect({ message: "fixture cut", cause: "fixture" }),
});
type Read = () => Stream.Stream<AssetReadEvent, AssetReadFailure>;
const harness = Effect.fn(function* (initialRead: Read = () => Stream.fromArray(events)) {
  let lifetime: object = {};
  let read = initialRead;
  let reads = 0;
  let created = 0;
  const revoked: string[] = [];
  const buffers: unknown[] = [];
  const target = new PrimaryConnectionTarget({
    environmentId,
    label: "Host",
    httpBaseUrl: "https://host.invalid",
    wsBaseUrl: "wss://host.invalid",
  });
  const descriptor = (store: string | null, capable: boolean) =>
    decodeEnvironmentDescriptor({
      environmentId,
      label: "Host",
      serverVersion: "test",
      platform: { os: "linux", arch: "x64" },
      storageInstanceId: store,
      capabilities: { inChannelTransfers: capable },
    });
  const session = (store: string | null = "store", capable = true): RpcSession => ({
    client: {
      [WS_METHODS.assetsRead]: (_input: unknown, options: unknown) => {
        reads += 1;
        buffers.push(options);
        return read();
      },
    } as unknown as RpcSession["client"],
    initialConfig: Effect.succeed({ environment: descriptor(store, capable) } as ServerConfig),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
    e2eeAuthenticated: Effect.succeed(null),
  });
  const prepared: PreparedConnection = {
    target,
    environmentId,
    label: "Host",
    descriptor: descriptor("store", true),
    httpBaseUrl: target.httpBaseUrl,
    socketUrl: `${target.wsBaseUrl}/ws-e2ee`,
    httpAuthorization: null,
    e2ee: { hostKey: "pin", auth: { kind: "bearer", credential: "fixture" } },
  };
  let supervisor = EnvironmentSupervisor.of({
    target,
    session: yield* SubscriptionRef.make(Option.some(session())),
    prepared: yield* SubscriptionRef.make(Option.some(prepared)),
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      phase: "connected",
      generation: 1,
    }),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map([[environmentId, { target, profile: Option.none() }]]),
  );
  const supervisors = yield* SubscriptionRef.make(supervisor);
  const additionalSupervisors = new Map<EnvironmentId, EnvironmentSupervisor["Service"]>();
  const additionalLifetimes = new Map<EnvironmentId, object>();
  const fixture: Pick<
    EnvironmentRegistry["Service"],
    "entries" | "registrationLifetime" | "run" | "followStream"
  > = {
    entries,
    registrationLifetime: (id) =>
      Effect.sync(() => (id === environmentId ? lifetime : additionalLifetimes.get(id)!)),
    run: (id, effect) =>
      Effect.provideService(
        effect,
        EnvironmentSupervisor,
        additionalSupervisors.get(id) ?? supervisor,
      ),
    followStream: (id, stream) =>
      id !== environmentId
        ? Stream.provideService(stream, EnvironmentSupervisor, additionalSupervisors.get(id)!)
        : SubscriptionRef.changes(supervisors).pipe(
            Stream.switchMap((current) =>
              Stream.provideService(stream, EnvironmentSupervisor, current),
            ),
          ),
  };
  const registry = fixture as EnvironmentRegistry["Service"];
  const ownerScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(ownerScope, Exit.void));
  let catalogPaused = false;
  const queued: Array<() => void> = [];
  const backingScheduler = new Scheduler.MixedScheduler();
  const scheduler: Scheduler.Scheduler = {
    executionMode: backingScheduler.executionMode,
    shouldYield: (fiber) => catalogPaused || backingScheduler.shouldYield(fiber),
    makeDispatcher: () => {
      const dispatcher = backingScheduler.makeDispatcher();
      return {
        flush: () => {
          if (!catalogPaused) dispatcher.flush();
        },
        scheduleTask: (task, priority) => {
          if (catalogPaused) queued.push(() => dispatcher.scheduleTask(task, priority));
          else dispatcher.scheduleTask(task, priority);
        },
      };
    },
  };
  const owner = yield* makeAssetByteCacheOwner({
    urls: {
      create: () => `blob:owner-${++created}`,
      revoke: (value) => {
        revoked.push(value);
      },
    },
  }).pipe(
    Effect.provideService(EnvironmentRegistry, registry),
    Effect.provideService(Scope.Scope, ownerScope),
    Effect.provideService(Scheduler.Scheduler, scheduler),
  );
  return {
    owner,
    registry,
    get supervisor() {
      return supervisor;
    },
    target,
    reads: () => reads,
    created: () => created,
    revoked,
    buffers,
    dispose: () => Scope.close(ownerScope, Exit.void),
    addEnvironment: (id: EnvironmentId) =>
      Effect.gen(function* () {
        const extraTarget = new PrimaryConnectionTarget({
          ...target,
          environmentId: id,
          httpBaseUrl: `https://${id}.invalid`,
          wsBaseUrl: `wss://${id}.invalid`,
        });
        const extra = {
          ...supervisor,
          target: extraTarget,
          session: yield* SubscriptionRef.make(Option.some(session())),
          prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
            Option.some({
              ...prepared,
              target: extraTarget,
              environmentId: id,
              httpBaseUrl: extraTarget.httpBaseUrl,
              socketUrl: `${extraTarget.wsBaseUrl}/ws-e2ee`,
            }),
          ),
          state: yield* SubscriptionRef.make<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            desired: true,
            phase: "connected",
            generation: 1,
          }),
        };
        additionalSupervisors.set(id, extra);
        additionalLifetimes.set(id, {});
        yield* SubscriptionRef.update(entries, (values) =>
          new Map(values).set(id, { target: extraTarget, profile: Option.none() }),
        );
      }),
    replaceLifetime: () => {
      lifetime = {};
    },
    pauseCatalog: () => {
      catalogPaused = true;
    },
    resumeCatalog: () => {
      catalogPaused = false;
      for (const resume of queued.splice(0)) resume();
    },
    retarget: Effect.gen(function* () {
      const replacement = new PrimaryConnectionTarget({
        ...target,
        httpBaseUrl: "https://other.invalid",
        wsBaseUrl: "wss://other.invalid",
      });
      supervisor = {
        ...supervisor,
        target: replacement,
        session: yield* SubscriptionRef.make(Option.some(session())),
        prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
          Option.some({
            ...prepared,
            target: replacement,
            httpBaseUrl: replacement.httpBaseUrl,
            socketUrl: `${replacement.wsBaseUrl}/ws-e2ee`,
          }),
        ),
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          phase: "connected",
          generation: 2,
        }),
      };
      yield* SubscriptionRef.set(supervisors, supervisor);
      yield* SubscriptionRef.set(
        entries,
        new Map([[environmentId, { target: replacement, profile: Option.none() }]]),
      );
    }),
    change: (
      options: {
        readonly store?: string | null;
        readonly capable?: boolean;
        readonly pinned?: boolean;
        readonly renamed?: boolean;
      } = {},
    ) =>
      Effect.gen(function* () {
        yield* SubscriptionRef.set(
          supervisor.session,
          Option.some(session(options.store, options.capable)),
        );
        yield* SubscriptionRef.set(
          supervisor.prepared,
          Option.some({
            ...prepared,
            label: options.renamed ? "New label" : "Host",
            e2ee:
              options.pinned === false
                ? null
                : {
                    hostKey: "pin",
                    auth: { kind: "bearer", credential: "rotated" },
                  },
          }),
        );
        yield* SubscriptionRef.update(supervisor.state, (value) => ({
          ...value,
          generation: value.generation + 1,
        }));
      }),
    setRead: (next: Read) => {
      read = next;
    },
  };
});
type ChannelView = Extract<AssetContentView, { readonly route: "in-channel" }>;
const channel = (owner: AssetByteCacheOwner) =>
  owner.watch(environmentId).pipe(
    Stream.filter((view): view is ChannelView => view.route === "in-channel"),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

describe("environment asset cache owner", () => {
  it.effect(
    "retires only malformed endpoint authority and still handles its later removal and re-add",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const original = yield* channel(h.owner);
        const old = yield* original.cache.acquire(resource);
        old.release();
        const otherId = EnvironmentId.make("unrelated");
        yield* h.addEnvironment(otherId);
        const other = yield* h.owner.watch(otherId).pipe(
          Stream.filter((view): view is ChannelView => view.route === "in-channel"),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        const visible = yield* other.cache.acquire(resource);
        const malformed = new PrimaryConnectionTarget({
          ...h.target,
          httpBaseUrl: "malformed-endpoint-fixture",
        });
        yield* SubscriptionRef.update(h.registry.entries, (values) =>
          new Map(values).set(environmentId, { target: malformed, profile: Option.none() }),
        );
        for (let i = 0; i < 30; i++) yield* Effect.yieldNow;
        const badView = yield* Effect.exit(
          h.owner.watch(environmentId).pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
        );
        yield* SubscriptionRef.update(h.registry.entries, (values) => {
          const copy = new Map(values);
          copy.delete(environmentId);
          return copy;
        });
        for (let i = 0; i < 30; i++) yield* Effect.yieldNow;
        const revokedAfterRemoval = [...h.revoked];
        const stale = yield* Effect.exit(original.cache.acquire(resource));
        if (Exit.isSuccess(stale)) stale.value.release();
        h.replaceLifetime();
        yield* SubscriptionRef.update(h.registry.entries, (values) =>
          new Map(values).set(environmentId, { target: h.target, profile: Option.none() }),
        );
        const replacement = yield* channel(h.owner);
        (yield* replacement.cache.acquire(resource)).release();
        expect(badView).toMatchObject({ _tag: "Success", value: { route: "unavailable" } });
        expect(Exit.isFailure(stale)).toBe(true);
        expect(revokedAfterRemoval).toEqual([old.url]);
        expect(h.revoked).not.toContain(visible.url);
        expect(replacement.cache).not.toBe(original.cache);
        visible.release();
      }),
  );
  it.effect(
    "retires an epoch when removal and identical re-add happen in one scheduling turn",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const original = yield* channel(h.owner);
        const old = yield* original.cache.acquire(resource);
        old.release();
        h.pauseCatalog();
        try {
          h.replaceLifetime();
          yield* SubscriptionRef.set(h.registry.entries, new Map()).pipe(
            Effect.andThen(
              SubscriptionRef.set(
                h.registry.entries,
                new Map([[environmentId, { target: h.target, profile: Option.none() }]]),
              ),
            ),
          );
        } finally {
          h.resumeCatalog();
        }
        for (let i = 0; i < 30; i++) yield* Effect.yieldNow;
        const current = yield* channel(h.owner);
        expect(current.cache).not.toBe(original.cache);
        expect(h.revoked).toEqual([old.url]);
      }),
  );
  it.effect("does not resurrect an owner after its runtime scope closes", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const view = yield* channel(h.owner);
      (yield* view.cache.acquire(resource)).release();
      yield* h.dispose();
      yield* h.owner.watch(environmentId).pipe(Stream.runHead);
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
      const latest = yield* h.owner
        .watch(environmentId)
        .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
      expect(latest.route).toBe("unavailable");
      expect(h.reads()).toBe(1);
      expect(h.revoked).toEqual(["blob:owner-1"]);
    }),
  );

  it.effect("a typed refusal never spends an automatic reissue", () =>
    Effect.gen(function* () {
      const failure = new AssetTooLargeError({
        resource,
        limitBytes: 10 * 1024 * 1024,
        message: "too large",
      });
      const h = yield* harness(() => Stream.fail(failure));
      const view = yield* channel(h.owner);
      const result = yield* Effect.exit(view.cache.acquire(resource));
      expect(result).toMatchObject({ _tag: "Failure", cause: { reasons: [{ error: failure }] } });
      expect(h.reads()).toBe(1);
    }),
  );

  it.effect(
    "a same-ID target replacement interrupts an old read and gives the new host a fresh cache",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        let stopped = 0;
        const h = yield* harness(() =>
          Stream.fromEffect(Deferred.succeed(entered, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.never),
            Stream.ensuring(
              Effect.sync(() => {
                stopped += 1;
              }),
            ),
          ),
        );
        const first = yield* channel(h.owner);
        const pending = yield* first.cache.acquire(resource).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        h.setRead(() => Stream.fromArray(events));
        yield* h.retarget;
        const replacement = yield* h.owner.watch(environmentId).pipe(
          Stream.filter(
            (view): view is ChannelView =>
              view.route === "in-channel" && view.cache !== first.cache,
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(Exit.isFailure(yield* Fiber.await(pending))).toBe(true);
        expect(stopped).toBe(1);
        (yield* replacement.cache.acquire(resource)).release();
        expect(h.created()).toBe(1);
      }),
  );

  it.effect("does not reuse byte entries across sessions without a verified store identity", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.change({ store: null });
      const first = yield* channel(h.owner);
      const old = yield* first.cache.acquire(resource);
      old.release();
      yield* h.change({ store: null });
      const next = yield* h.owner.watch(environmentId).pipe(
        Stream.filter(
          (view): view is ChannelView => view.route === "in-channel" && view.cache !== first.cache,
        ),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      const current = yield* next.cache.acquire(resource);
      expect(current.url).not.toBe(old.url);
      current.release();
      expect(h.reads()).toBe(2);
      expect(h.revoked).toEqual([old.url]);
    }),
  );
  it.effect(
    "reuses completed bytes across same-store reconnect, rename and credential rotation",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const first = yield* channel(h.owner);
        const a = yield* first.cache.acquire(resource);
        a.release();
        yield* h.change({ renamed: true });
        yield* Effect.yieldNow;
        const second = yield* channel(h.owner);
        expect(second.cache).toBe(first.cache);
        const b = yield* second.cache.acquire(resource);
        expect(b.url).toBe(a.url);
        b.release();
        expect(h.reads()).toBe(1);
        expect(h.buffers).toEqual([{ streamBufferSize: 2 }]);
      }),
  );

  it.effect("reissues one partial transport cut from zero using a fresh attempt", () =>
    Effect.gen(function* () {
      let cut = Effect.void;
      const h = yield* harness(() =>
        Stream.fromArray(events.slice(0, 2)).pipe(
          Stream.concat(Stream.fromEffect(Effect.suspend(() => cut)).pipe(Stream.drain)),
          Stream.concat(Stream.fail(transport)),
        ),
      );
      cut = Effect.sync(() => h.setRead(() => Stream.fromArray(events))).pipe(
        Effect.andThen(h.change()),
      );
      const view = yield* channel(h.owner);
      const lease = yield* view.cache.acquire(resource);
      lease.release();
      expect(h.reads()).toBe(2);
      expect(h.created()).toBe(1);
    }),
  );

  it.effect("does not reset the second-cut budget on later generation churn", () =>
    Effect.gen(function* () {
      let cut = Effect.void;
      const h = yield* harness(() =>
        Stream.fromArray(events.slice(0, 2)).pipe(
          Stream.concat(Stream.fromEffect(Effect.suspend(() => cut)).pipe(Stream.drain)),
          Stream.concat(Stream.fail(transport)),
        ),
      );
      cut = h.change();
      const view = yield* channel(h.owner);
      expect(Exit.isFailure(yield* Effect.exit(view.cache.acquire(resource)))).toBe(true);
      expect(h.reads()).toBe(2);
      expect(h.created()).toBe(0);
      for (let i = 0; i < 4; i++) yield* h.change();
      const latest = yield* channel(h.owner);
      expect(latest.cache).toBe(view.cache);
      expect(h.reads()).toBe(2);
    }),
  );

  it.effect("replaces the epoch and revokes old URLs when the accepted store changes", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const first = yield* channel(h.owner);
      const old = yield* first.cache.acquire(resource);
      yield* h.change({ store: "replacement" });
      const second = yield* h.owner.watch(environmentId).pipe(
        Stream.filter(
          (view): view is ChannelView => view.route === "in-channel" && view.cache !== first.cache,
        ),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(h.revoked).toEqual([old.url]);
      const current = yield* second.cache.acquire(resource);
      old.release();
      expect(current.url).not.toBe(old.url);
      expect(h.revoked).toEqual([old.url]);
      current.release();
    }),
  );

  it.effect("removal interrupts a pending read and re-add uses a fresh epoch", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      let stopped = 0;
      const h = yield* harness(() =>
        Stream.fromEffect(Deferred.succeed(entered, undefined)).pipe(
          Stream.drain,
          Stream.concat(Stream.never),
          Stream.ensuring(
            Effect.sync(() => {
              stopped += 1;
            }),
          ),
        ),
      );
      const first = yield* channel(h.owner);
      const pending = yield* first.cache.acquire(resource).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* SubscriptionRef.set(h.registry.entries, new Map());
      yield* h.owner.watch(environmentId).pipe(
        Stream.filter((view) => view.route === "unavailable"),
        Stream.runHead,
      );
      expect(Exit.isFailure(yield* Fiber.await(pending))).toBe(true);
      expect(stopped).toBe(1);
      h.setRead(() => Stream.fromArray(events));
      yield* SubscriptionRef.set(
        h.registry.entries,
        new Map([[environmentId, { target: h.target, profile: Option.none() }]]),
      );
      const next = yield* channel(h.owner);
      expect(next.cache).not.toBe(first.cache);
      (yield* next.cache.acquire(resource)).release();
    }),
  );

  it.effect("capability loss publishes unavailable without starting a replacement read", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const first = yield* channel(h.owner);
      const lease = yield* first.cache.acquire(resource);
      yield* h.change({ capable: false });
      yield* h.owner.watch(environmentId).pipe(
        Stream.filter((view) => view.route === "unavailable"),
        Stream.runHead,
      );
      expect(h.reads()).toBe(1);
      for (let i = 0; i < 100 && h.revoked.length === 0; i++) yield* Effect.yieldNow;
      expect(h.revoked).toEqual([lease.url]);
      lease.release();
    }),
  );

  it.effect(
    "keeps completed entries through a transient missing session but starts no new I/O",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const view = yield* channel(h.owner);
        const lease = yield* view.cache.acquire(resource);
        lease.release();
        yield* SubscriptionRef.set(h.supervisor.session, Option.none());
        yield* SubscriptionRef.update(h.supervisor.state, (value) => ({
          ...value,
          phase: "backoff" as const,
        }));
        const offline = yield* channel(h.owner);
        expect(offline.cache).toBe(view.cache);
        const cached = yield* offline.cache.acquire(resource);
        expect(cached.url).toBe(lease.url);
        cached.release();
        expect(
          Exit.isFailure(
            yield* Effect.exit(offline.cache.acquire({ _tag: "attachment", attachmentId: "new" })),
          ),
        ).toBe(true);
        expect(h.reads()).toBe(1);
      }),
  );
});
