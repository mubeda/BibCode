import { type EnvironmentId, WS_METHODS } from "@bibcode/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { isSessionTransportLoss, nextSession } from "../connection/nextSession.ts";
import { fileContentRoute } from "../operations/fileContentRoute.ts";
import {
  assertFileContentIdentity,
  fileContentCatalogKey,
  readFileTransferSession,
  sameFileContentIdentity,
  type FileContentIdentity,
  type FileTransferSession,
} from "../operations/fileTransferSession.ts";
import {
  currentSession,
  EnvironmentRpcUnavailableError,
  runStreamInSession,
} from "../rpc/client.ts";
import {
  makeAssetByteCache,
  type AssetByteCache,
  type AssetReadAttempt,
  type AssetReadPort,
  type AssetUrlFactory,
} from "./assetByteCache.ts";

export type AssetContentView =
  | { readonly route: "unavailable" }
  | { readonly route: "http"; readonly identity: FileContentIdentity; readonly httpBaseUrl: string }
  | {
      readonly route: "in-channel";
      readonly identity: FileContentIdentity;
      readonly cache: AssetByteCache;
    };
export interface AssetByteCacheOwner {
  readonly watch: (environmentId: EnvironmentId) => Stream.Stream<AssetContentView>;
}
const UNAVAILABLE: AssetContentView = { route: "unavailable" };
interface Slot {
  readonly environmentId: EnvironmentId;
  readonly gate: Semaphore.Semaphore;
  catalogKey: string | null;
  lifetime: object | null;
  scope: Scope.Closeable | null;
  view: AssetContentView;
}

function readPort(
  registry: EnvironmentRegistry["Service"],
  initial: FileTransferSession,
): AssetReadPort {
  const environmentId = initial.supervisor.target.environmentId;
  const unavailable = () =>
    new EnvironmentRpcUnavailableError({
      environmentId,
      message: "This asset's connection or data store changed.",
    });
  return {
    open: Effect.fn("AssetBytes.open")(function* (resource) {
      const supervisor = yield* registry
        .run(environmentId, EnvironmentSupervisor)
        .pipe(Effect.mapError(unavailable));
      const session = yield* currentSession().pipe(
        Effect.provideService(EnvironmentSupervisor, supervisor),
      );
      let carrying = yield* readFileTransferSession(registry, supervisor, session);
      if (
        !sameFileContentIdentity(initial.identity, carrying.identity) ||
        fileContentRoute(carrying.prepared, carrying.config) !== "in-channel"
      )
        return yield* unavailable();
      let remaining = 1;
      const attempt = (): AssetReadAttempt => ({
        events: runStreamInSession(
          carrying.session,
          environmentId,
          WS_METHODS.assetsRead,
          { resource },
          { streamBufferSize: 2 },
        ).pipe(
          Stream.concat(
            Stream.fromEffect(assertFileContentIdentity(registry, initial)).pipe(Stream.drain),
          ),
        ),
        retryAfter: Effect.fn("AssetBytes.retryAfter")(function* (cause) {
          if (remaining === 0 || !isSessionTransportLoss(cause)) return null;
          remaining -= 1;
          yield* assertFileContentIdentity(registry, initial);
          const next = yield* nextSession(registry, carrying.supervisor, carrying.session);
          if (next._tag === "Stopped") return yield* unavailable();
          carrying = yield* readFileTransferSession(registry, next.supervisor, next.session);
          if (
            !sameFileContentIdentity(initial.identity, carrying.identity) ||
            fileContentRoute(carrying.prepared, carrying.config) !== "in-channel"
          )
            return yield* unavailable();
          return attempt();
        }),
      });
      return attempt();
    }),
  };
}

/** One scoped application owner; cache epochs outlive consumers but not their environment. */
export const makeAssetByteCacheOwner = Effect.fn("AssetBytes.makeOwner")(function* (input: {
  readonly urls: AssetUrlFactory;
  readonly budgetBytes?: number;
}): Effect.fn.Return<AssetByteCacheOwner, never, EnvironmentRegistry | Scope.Scope> {
  const registry = yield* EnvironmentRegistry;
  const slots = new Map<EnvironmentId, Slot>();
  let disposed = false;
  const views = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, AssetContentView>>(
    new Map(),
  );
  const publish = (slot: Slot, view: AssetContentView) => {
    if (slot.view === view) return Effect.void;
    slot.view = view;
    return SubscriptionRef.update(views, (values) => new Map(values).set(slot.environmentId, view));
  };
  const clearCache = (slot: Slot) =>
    Effect.gen(function* () {
      const old = slot.view;
      yield* publish(slot, UNAVAILABLE);
      if (old.route === "in-channel") yield* old.cache.dispose();
    });
  const closeSlot = (slot: Slot) =>
    Effect.gen(function* () {
      const scope = slot.scope;
      slot.scope = null;
      // Hide the old epoch immediately; join its readers before publishing a replacement.
      const old = slot.view;
      yield* publish(slot, UNAVAILABLE);
      if (scope !== null) yield* Scope.close(scope, Exit.void);
      if (old.route === "in-channel") yield* old.cache.dispose();
    });
  const accept = (slot: Slot, candidate: FileTransferSession) =>
    Effect.gen(function* () {
      const entry = (yield* SubscriptionRef.get(registry.entries)).get(slot.environmentId);
      const catalogKey = entry === undefined ? null : fileContentCatalogKey(entry);
      if (
        catalogKey === null ||
        catalogKey !== slot.catalogKey ||
        candidate.identity.registrationLifetime !== slot.lifetime
      )
        return;
      const route = fileContentRoute(candidate.prepared, candidate.config);
      if (route === "unavailable") {
        yield* clearCache(slot);
        return;
      }
      if (
        slot.view.route === route &&
        sameFileContentIdentity(slot.view.identity, candidate.identity)
      )
        return;
      yield* clearCache(slot);
      // Disposing old readers can suspend; never publish the stale candidate afterward.
      const fresh = yield* readFileTransferSession(
        registry,
        candidate.supervisor,
        candidate.session,
      ).pipe(Effect.option);
      if (Option.isNone(fresh)) return;
      const carrying = fresh.value;
      if (
        route !== fileContentRoute(carrying.prepared, carrying.config) ||
        !sameFileContentIdentity(candidate.identity, carrying.identity)
      )
        return;
      if (route === "http")
        yield* publish(slot, {
          route,
          identity: carrying.identity,
          httpBaseUrl: carrying.prepared.httpBaseUrl,
        });
      else
        yield* publish(slot, {
          route,
          identity: carrying.identity,
          cache: makeAssetByteCache({
            port: readPort(registry, carrying),
            urls: input.urls,
            ...(input.budgetBytes === undefined ? {} : { budgetBytes: input.budgetBytes }),
          }),
        });
    });
  const observe = (slot: Slot) => {
    const current = Stream.unwrap(
      Effect.gen(function* () {
        const supervisor = yield* EnvironmentSupervisor;
        return SubscriptionRef.changes(supervisor.state).pipe(
          Stream.mapEffect((state) =>
            Effect.gen(function* () {
              if (state.phase !== "connected")
                return { state, carrying: Option.none<FileTransferSession>() };
              const carrying = yield* currentSession().pipe(
                Effect.flatMap((session) => readFileTransferSession(registry, supervisor, session)),
                Effect.option,
                Effect.provideService(EnvironmentSupervisor, supervisor),
              );
              return { state, carrying };
            }),
          ),
        );
      }),
    );
    return registry.followStream(slot.environmentId, current).pipe(
      Stream.runForEach(({ state, carrying }) =>
        slot.gate.withPermits(1)(
          Effect.gen(function* () {
            if (!state.desired || state.phase === "blocked") {
              yield* clearCache(slot);
              return;
            }
            if (Option.isSome(carrying)) yield* accept(slot, carrying.value);
            else if (slot.view.route === "http") yield* clearCache(slot);
            // An ordinary reconnect preserves authorized complete byte entries. A new
            // acquire still needs a carrying session unless it can use a complete entry.
          }),
        ),
      ),
    );
  };
  const reconcile = (slot: Slot) =>
    slot.gate.withPermits(1)(
      Effect.gen(function* () {
        if (disposed) return;
        const entry = (yield* SubscriptionRef.get(registry.entries)).get(slot.environmentId);
        const key = entry === undefined ? null : fileContentCatalogKey(entry);
        const lifetime = Option.getOrNull(
          yield* registry.registrationLifetime(slot.environmentId).pipe(Effect.option),
        );
        if (
          slot.catalogKey === key &&
          slot.lifetime === lifetime &&
          (key === null || slot.scope !== null)
        )
          return;
        yield* closeSlot(slot);
        slot.catalogKey = key;
        slot.lifetime = lifetime;
        if (entry !== undefined && key !== null && lifetime !== null) {
          const scope = Scope.makeUnsafe();
          slot.scope = scope;
          yield* Effect.forkIn(observe(slot), scope);
        }
      }),
    );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      disposed = true;
      yield* Effect.forEach(slots.values(), (slot) => slot.gate.withPermits(1)(closeSlot(slot)), {
        concurrency: "unbounded",
      });
      slots.clear();
      yield* SubscriptionRef.set(views, new Map());
    }),
  );
  yield* SubscriptionRef.changes(registry.entries).pipe(
    Stream.runForEach(() =>
      Effect.forEach(slots.values(), reconcile, { concurrency: "unbounded" }).pipe(Effect.asVoid),
    ),
    Effect.forkScoped,
  );
  return {
    watch: (environmentId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (disposed) return Stream.succeed(UNAVAILABLE);
          let slot = slots.get(environmentId);
          if (slot === undefined) {
            slot = {
              environmentId,
              gate: Semaphore.makeUnsafe(1),
              catalogKey: null,
              lifetime: null,
              scope: null,
              view: UNAVAILABLE,
            };
            slots.set(environmentId, slot);
          }
          yield* reconcile(slot);
          return SubscriptionRef.changes(views).pipe(
            Stream.map((values) => values.get(environmentId) ?? UNAVAILABLE),
            Stream.changesWith((a, b) => a === b),
          );
        }),
      ),
  };
});
