import {
  AssetResource,
  AssetTooLargeError,
  type AssetReadEvent,
  WS_METHODS,
} from "@bibcode/contracts";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { decodeTransferChunk, FileTransferClientError } from "../operations/fileTransfers.ts";
import type { EnvironmentRpcStreamFailure, EnvironmentRpcUnavailableError } from "../rpc/client.ts";

export interface AssetUrlLease {
  readonly url: string;
  readonly sizeBytes: number;
  readonly release: () => void;
}
export interface AssetUrlFactory {
  readonly create: (blob: Blob) => string;
  readonly revoke: (url: string) => void;
}
export interface AssetByteCache {
  readonly acquire: (resource: AssetResource) => Effect.Effect<AssetUrlLease, AssetReadFailure>;
  readonly dispose: () => Effect.Effect<void>;
}
export type AssetReadFailure =
  | EnvironmentRpcStreamFailure<typeof WS_METHODS.assetsRead>
  | FileTransferClientError
  | EnvironmentRpcUnavailableError;

/** A fresh validation buffer belongs to each attempt, never to the retrying flat stream. */
export interface AssetReadAttempt {
  readonly events: Stream.Stream<AssetReadEvent, AssetReadFailure>;
  readonly retryAfter: (
    cause: Cause.Cause<AssetReadFailure>,
  ) => Effect.Effect<AssetReadAttempt | null, AssetReadFailure>;
}
export interface AssetReadPort {
  readonly open: (resource: AssetResource) => Effect.Effect<AssetReadAttempt, AssetReadFailure>;
}

const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const keyOf = Schema.encodeSync(Schema.fromJsonString(AssetResource));
const invalid = () =>
  new FileTransferClientError({
    reason: "protocol",
    message: "The server sent an incomplete or invalid asset.",
  });
const unavailable = () =>
  new FileTransferClientError({
    reason: "unavailable",
    message: "This asset's environment is no longer available.",
  });
interface ReadyAsset {
  readonly url: string;
  readonly sizeBytes: number;
}
interface Entry {
  readonly key: string;
  readonly result: Deferred.Deferred<ReadyAsset, AssetReadFailure>;
  references: number;
  recency: number;
  ready: ReadyAsset | null;
  fiber: Fiber.Fiber<void> | null;
}

const readAttempt = Effect.fn("AssetBytes.readAttempt")(function* (
  resource: AssetResource,
  events: AssetReadAttempt["events"],
) {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let metadata: Extract<AssetReadEvent, { readonly _tag: "start" }> | null = null;
  let received = 0;
  let ended = false;
  const tooLarge = () =>
    new AssetTooLargeError({
      resource,
      limitBytes: MAX_ASSET_BYTES,
      message: "Asset exceeds the 10 MiB response limit.",
    });
  return yield* Effect.gen(function* () {
    yield* events.pipe(
      Stream.runForEach(
        Effect.fn("AssetBytes.acceptEvent")(function* (event) {
          if (ended) return yield* invalid();
          switch (event._tag) {
            case "start":
              if (
                metadata !== null ||
                !Number.isSafeInteger(event.sizeBytes) ||
                event.sizeBytes < 0 ||
                !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(event.mimeType)
              )
                return yield* invalid();
              if (event.sizeBytes > MAX_ASSET_BYTES) return yield* tooLarge();
              metadata = event;
              return;
            case "bytes": {
              if (metadata === null || event.offset !== received) return yield* invalid();
              const bytes = yield* decodeTransferChunk(event.data);
              received += bytes.byteLength;
              if (received > MAX_ASSET_BYTES) return yield* tooLarge();
              if (received > metadata.sizeBytes) return yield* invalid();
              chunks.push(new Uint8Array(bytes));
              return;
            }
            case "end":
              if (metadata === null || received !== metadata.sizeBytes) return yield* invalid();
              ended = true;
          }
        }),
      ),
    );
    // The entire stream includes its terminal RPC Exit, even after an end value.
    if (!ended || metadata === null) return yield* invalid();
    return new Blob(chunks, { type: metadata.mimeType });
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        chunks.length = 0;
      }),
    ),
  );
});

export function makeAssetByteCache(input: {
  readonly port: AssetReadPort;
  readonly urls: AssetUrlFactory;
  readonly budgetBytes?: number;
}): AssetByteCache {
  const scope = Scope.makeUnsafe();
  const readers = Semaphore.makeUnsafe(2);
  const entries = new Map<string, Entry>();
  const disposedDone = Deferred.makeUnsafe<void>();
  const budget = Math.max(0, input.budgetBytes ?? 64 * 1024 * 1024);
  let disposed = false;
  let clock = 0;
  let unreferencedBytes = 0;

  const evict = () => {
    while (unreferencedBytes > budget) {
      let oldest: Entry | undefined;
      for (const entry of entries.values()) {
        if (
          entry.references === 0 &&
          entry.ready !== null &&
          (oldest === undefined || entry.recency < oldest.recency)
        )
          oldest = entry;
      }
      if (oldest === undefined || oldest.ready === null) return;
      entries.delete(oldest.key);
      unreferencedBytes -= oldest.ready.sizeBytes;
      input.urls.revoke(oldest.ready.url);
    }
  };
  const releaseReady = (entry: Entry) => {
    if (disposed || entries.get(entry.key) !== entry || entry.ready === null) return;
    entry.references -= 1;
    if (entry.references === 0) {
      entry.recency = ++clock;
      unreferencedBytes += entry.ready.sizeBytes;
      evict();
    }
  };
  const releaseWaiter = (entry: Entry) =>
    Effect.suspend(() => {
      if (entries.get(entry.key) !== entry) return Effect.void;
      if (entry.ready !== null) return Effect.sync(() => releaseReady(entry));
      entry.references -= 1;
      if (entry.references > 0) return Effect.void;
      entries.delete(entry.key);
      return entry.fiber === null ? Effect.void : Fiber.interrupt(entry.fiber);
    });
  const read = Effect.fn("AssetBytes.read")(function* (resource: AssetResource) {
    let attempt = yield* input.port.open(resource);
    while (true) {
      const result = yield* Effect.exit(readAttempt(resource, attempt.events));
      if (Exit.isSuccess(result)) return result.value;
      // readAttempt has joined its stream and released every partial chunk before this wait.
      const next = yield* attempt.retryAfter(result.cause);
      if (next === null) return yield* Effect.failCause(result.cause);
      attempt = next;
    }
  });
  const produce = (entry: Entry, resource: AssetResource) =>
    readers
      .withPermits(1)(read(resource))
      .pipe(
        Effect.flatMap((blob) =>
          Effect.try({
            try: () => {
              if (disposed || entries.get(entry.key) !== entry || entry.references === 0)
                throw unavailable();
              const ready = { url: input.urls.create(blob), sizeBytes: blob.size };
              entry.ready = ready;
              return ready;
            },
            catch: () => unavailable(),
          }),
        ),
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            if (Exit.isFailure(exit) && entries.get(entry.key) === entry) entries.delete(entry.key);
            yield* Deferred.done(entry.result, exit);
          }),
        ),
        Effect.asVoid,
        Effect.ignoreCause,
      );
  const acquire = Effect.fn("AssetBytes.acquire")(function* (resource: AssetResource) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (disposed) return yield* unavailable();
        const key = keyOf(resource);
        let entry = entries.get(key);
        if (entry === undefined) {
          entry = {
            key,
            result: Deferred.makeUnsafe(),
            references: 1,
            recency: ++clock,
            ready: null,
            fiber: null,
          };
          entries.set(key, entry);
          entry.fiber = yield* Effect.forkIn(produce(entry, resource), scope);
        } else {
          if (entry.ready !== null && entry.references === 0)
            unreferencedBytes -= entry.ready.sizeBytes;
          entry.references += 1;
          entry.recency = ++clock;
        }
        const owned = entry;
        return yield* restore(Deferred.await(owned.result)).pipe(
          Effect.flatMap((ready) => {
            if (disposed || entries.get(key) !== owned) return Effect.fail(unavailable());
            let released = false;
            return Effect.succeed({
              ...ready,
              release: () => {
                if (released) return;
                released = true;
                releaseReady(owned);
              },
            } satisfies AssetUrlLease);
          }),
          Effect.onExit((exit) => (Exit.isFailure(exit) ? releaseWaiter(owned) : Effect.void)),
        );
      }),
    );
  });
  const dispose = () =>
    Effect.uninterruptible(
      Effect.suspend(() => {
        if (disposed) return Deferred.await(disposedDone);
        disposed = true;
        return Scope.close(scope, Exit.void).pipe(
          Effect.andThen(
            Effect.sync(() => {
              for (const entry of entries.values())
                if (entry.ready !== null) input.urls.revoke(entry.ready.url);
              entries.clear();
              unreferencedBytes = 0;
            }),
          ),
          Effect.ensuring(Deferred.succeed(disposedDone, undefined)),
        );
      }),
    );
  return { acquire, dispose };
}
