import { AssetTooLargeError, type AssetReadEvent, type AssetResource } from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { FileTransferClientError } from "../operations/fileTransfers.ts";
import {
  makeAssetByteCache,
  type AssetReadAttempt,
  type AssetReadFailure,
  type AssetReadPort,
} from "./assetByteCache.ts";

const resource = (name = "a"): AssetResource => ({ _tag: "attachment", attachmentId: name });
const start = (sizeBytes = 3, mimeType = "image/png"): AssetReadEvent => ({
  _tag: "start",
  sizeBytes,
  mimeType,
});
const bytes = (offset = 0, data = "YWJj"): AssetReadEvent => ({ _tag: "bytes", offset, data });
const end: AssetReadEvent = { _tag: "end" };
const attempt = (events: Stream.Stream<AssetReadEvent, AssetReadFailure>): AssetReadAttempt => ({
  events,
  retryAfter: () => Effect.succeed(null),
});
const setup = Effect.fn(function* (port: AssetReadPort, budgetBytes = 64 * 1024 * 1024) {
  const created: Blob[] = [];
  const revoked: string[] = [];
  const cache = makeAssetByteCache({
    port,
    budgetBytes,
    urls: {
      create: (blob) => {
        created.push(blob);
        return `blob:fixture-${created.length}`;
      },
      revoke: (url) => {
        revoked.push(url);
      },
    },
  });
  yield* Effect.addFinalizer(cache.dispose);
  return { cache, created, revoked };
});
const waitFor = (predicate: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die("Expected asset cache transition was not observed");
  });

describe("asset byte cache", () => {
  it.effect("holds a reader permit while its retry waits for the replacement session", () =>
    Effect.gen(function* () {
      const retry = yield* Deferred.make<void>();
      const second = yield* Deferred.make<void>();
      let opened = 0;
      let waiting = false;
      const h = yield* setup({
        open: (item) =>
          Effect.sync(() => {
            opened += 1;
            return item._tag === "attachment" && item.attachmentId === "first"
              ? {
                  events: Stream.fail(
                    new FileTransferClientError({
                      reason: "unavailable",
                      message: "test retry seam",
                    }),
                  ),
                  retryAfter: () =>
                    Effect.sync(() => {
                      waiting = true;
                    }).pipe(
                      Effect.andThen(Deferred.await(retry)),
                      Effect.as(attempt(Stream.make(start(), bytes(), end))),
                    ),
                }
              : attempt(
                  Stream.fromEffect(Deferred.await(second)).pipe(
                    Stream.drain,
                    Stream.concat(Stream.make(start(), bytes(), end)),
                  ),
                );
          }),
      });
      const a = yield* h.cache.acquire(resource("first")).pipe(Effect.forkChild);
      const b = yield* h.cache.acquire(resource("second")).pipe(Effect.forkChild);
      const c = yield* h.cache.acquire(resource("third")).pipe(Effect.forkChild);
      yield* waitFor(() => waiting && opened === 2);
      yield* Effect.yieldNow;
      expect(opened).toBe(2);
      yield* Deferred.succeed(retry, undefined);
      (yield* Fiber.join(a)).release();
      yield* waitFor(() => opened === 3);
      yield* Deferred.succeed(second, undefined);
      (yield* Fiber.join(b)).release();
      (yield* Fiber.join(c)).release();
    }),
  );
  it.effect(
    "coalesces consumers into one exact MIME/byte URL with independent idempotent leases",
    () =>
      Effect.gen(function* () {
        let opened = 0;
        const gate = yield* Deferred.make<void>();
        const h = yield* setup({
          open: () =>
            Effect.sync(() => {
              opened += 1;
              return attempt(
                Stream.fromEffect(Deferred.await(gate)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.make(start(), bytes(), end)),
                ),
              );
            }),
        });
        const a = yield* h.cache.acquire(resource()).pipe(Effect.forkChild);
        const b = yield* h.cache.acquire(resource()).pipe(Effect.forkChild);
        yield* waitFor(() => opened === 1);
        expect(h.created).toHaveLength(0);
        yield* Deferred.succeed(gate, undefined);
        const first = yield* Fiber.join(a);
        const second = yield* Fiber.join(b);
        expect(first.url).toBe(second.url);
        expect(first.sizeBytes).toBe(3);
        expect(h.created).toHaveLength(1);
        expect(h.created[0]!.type).toBe("image/png");
        expect(new Uint8Array(yield* Effect.promise(() => h.created[0]!.arrayBuffer()))).toEqual(
          new Uint8Array([97, 98, 99]),
        );
        first.release();
        first.release();
        expect(h.revoked).toEqual([]);
        second.release();
        const reused = yield* h.cache.acquire(resource());
        expect(reused.url).toBe(first.url);
        expect(opened).toBe(1);
        reused.release();
      }),
  );

  it.effect("supports a valid empty exact asset", () =>
    Effect.gen(function* () {
      const h = yield* setup({
        open: () => Effect.succeed(attempt(Stream.make(start(0, "image/svg+xml"), end))),
      });
      const lease = yield* h.cache.acquire(resource());
      expect(lease.sizeBytes).toBe(0);
      expect(h.created[0]!.type).toBe("image/svg+xml");
      lease.release();
    }),
  );

  const malformed: ReadonlyArray<
    readonly [string, () => Stream.Stream<AssetReadEvent, AssetReadFailure>]
  > = [
    ["missing start", () => Stream.make(bytes(), end)],
    ["missing end", () => Stream.make(start(), bytes())],
    ["duplicate start", () => Stream.make(start(), start(), bytes(), end)],
    ["duplicate end", () => Stream.make(start(0), end, end)],
    ["gap", () => Stream.make(start(), bytes(1), end)],
    ["overlap", () => Stream.make(start(6), bytes(), bytes(), end)],
    ["early end", () => Stream.make(start(), end)],
    ["too many bytes", () => Stream.make(start(2), bytes(), end)],
    ["bytes after end", () => Stream.make(start(0), end, bytes())],
    ["malformed data", () => Stream.make(start(), bytes(0, "$invalid$"), end)],
    ["noncanonical data", () => Stream.make(start(1), bytes(0, "YR=="), end)],
    ["empty byte event", () => Stream.make(start(0), bytes(0, ""), end)],
    ["invalid MIME", () => Stream.make(start(0, "image/png\ntext/html"), end)],
  ];
  for (const [name, stream] of malformed)
    it.effect(`never publishes a URL for ${name}`, () =>
      Effect.gen(function* () {
        const h = yield* setup({ open: () => Effect.succeed(attempt(stream())) });
        const result = yield* Effect.exit(h.cache.acquire(resource()));
        expect(result).toMatchObject({
          _tag: "Failure",
          cause: { reasons: [{ error: { _tag: "FileTransferClientError", reason: "protocol" } }] },
        });
        expect(h.created).toHaveLength(0);
        expect(h.revoked).toHaveLength(0);
      }),
    );

  it.effect("requires successful RPC exit after end before creating a URL", () =>
    Effect.gen(function* () {
      const error = new FileTransferClientError({ reason: "unavailable", message: "late failure" });
      const h = yield* setup({
        open: () =>
          Effect.succeed(
            attempt(Stream.make(start(), bytes(), end).pipe(Stream.concat(Stream.fail(error)))),
          ),
      });
      const result = yield* Effect.exit(h.cache.acquire(resource()));
      expect(result).toMatchObject({ _tag: "Failure", cause: { reasons: [{ error }] } });
      expect(h.created).toHaveLength(0);
    }),
  );

  for (const growing of [false, true])
    it.effect(`enforces the 10 MiB ${growing ? "cumulative" : "announced"} limit`, () =>
      Effect.gen(function* () {
        const data = Encoding.encodeBase64(new Uint8Array(1024 * 1024));
        const events: AssetReadEvent[] = growing
          ? [
              start(10 * 1024 * 1024),
              ...Array.from({ length: 10 }, (_, i) => bytes(i * 1024 * 1024, data)),
              bytes(10 * 1024 * 1024, "YQ=="),
              end,
            ]
          : [start(10 * 1024 * 1024 + 1), end];
        const h = yield* setup({ open: () => Effect.succeed(attempt(Stream.fromArray(events))) });
        const result = yield* Effect.exit(h.cache.acquire(resource()));
        expect(result).toMatchObject({
          _tag: "Failure",
          cause: {
            reasons: [{ error: { _tag: "AssetTooLargeError", limitBytes: 10 * 1024 * 1024 } }],
          },
        });
        expect(h.created).toHaveLength(0);
      }),
    );

  it.effect("rejects a chunk over the raw 1 MiB ceiling", () =>
    Effect.gen(function* () {
      const size = 1024 * 1024 + 1;
      const h = yield* setup({
        open: () =>
          Effect.succeed(
            attempt(
              Stream.make(start(size), bytes(0, Encoding.encodeBase64(new Uint8Array(size))), end),
            ),
          ),
      });
      const result = yield* Effect.exit(h.cache.acquire(resource()));
      expect(result).toMatchObject({
        _tag: "Failure",
        cause: { reasons: [{ error: { reason: "protocol" } }] },
      });
      expect(h.created).toHaveLength(0);
    }),
  );

  it.effect("keeps a shared read when only one waiter is cancelled", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      let interrupted = 0;
      let opened = 0;
      const h = yield* setup({
        open: () =>
          Effect.sync(() => {
            opened += 1;
            return attempt(
              Stream.fromEffect(Deferred.await(gate)).pipe(
                Stream.drain,
                Stream.concat(Stream.make(start(), bytes(), end)),
                Stream.ensuring(
                  Effect.sync(() => {
                    interrupted += 1;
                  }),
                ),
              ),
            );
          }),
      });
      const a = yield* h.cache.acquire(resource()).pipe(Effect.forkChild);
      const b = yield* h.cache.acquire(resource()).pipe(Effect.forkChild);
      yield* waitFor(() => opened === 1);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(a);
      expect(interrupted).toBe(0);
      yield* Deferred.succeed(gate, undefined);
      const lease = yield* Fiber.join(b);
      expect(h.created).toHaveLength(1);
      lease.release();
    }),
  );

  it.effect("the last cancelled waiter joins real producer cleanup before returning", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const cleaning = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const h = yield* setup({
        open: () =>
          Effect.succeed(
            attempt(
              Stream.fromEffect(Deferred.succeed(entered, undefined)).pipe(
                Stream.drain,
                Stream.concat(Stream.never),
                Stream.ensuring(
                  Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(gate))),
                ),
              ),
            ),
          ),
      });
      const pending = yield* h.cache.acquire(resource()).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const cancel = yield* Fiber.interrupt(pending).pipe(Effect.forkChild);
      yield* Deferred.await(cleaning);
      expect(cancel.pollUnsafe()).toBeUndefined();
      expect(h.created).toHaveLength(0);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(cancel);
    }),
  );

  it.effect("runs at most two logical reads including their pending work", () =>
    Effect.gen(function* () {
      const gates = yield* Effect.forEach([0, 1, 2], () => Deferred.make<void>());
      let opened = 0;
      let live = 0;
      let peak = 0;
      const h = yield* setup({
        open: (item) =>
          Effect.sync(() => {
            const index = Number(item._tag === "attachment" ? item.attachmentId : "0");
            opened += 1;
            live += 1;
            peak = Math.max(peak, live);
            return attempt(
              Stream.fromEffect(Deferred.await(gates[index]!)).pipe(
                Stream.drain,
                Stream.concat(Stream.make(start(), bytes(), end)),
                Stream.ensuring(
                  Effect.sync(() => {
                    live -= 1;
                  }),
                ),
              ),
            );
          }),
      });
      const pending = yield* Effect.forEach([0, 1, 2], (i) =>
        h.cache.acquire(resource(String(i))).pipe(Effect.forkChild),
      );
      yield* waitFor(() => opened === 2);
      yield* Effect.yieldNow;
      expect(opened).toBe(2);
      yield* Deferred.succeed(gates[0]!, undefined);
      (yield* Fiber.join(pending[0]!)).release();
      yield* waitFor(() => opened === 3);
      expect(peak).toBe(2);
      yield* Deferred.succeed(gates[1]!, undefined);
      yield* Deferred.succeed(gates[2]!, undefined);
      (yield* Fiber.join(pending[1]!)).release();
      (yield* Fiber.join(pending[2]!)).release();
    }),
  );

  it.effect("evicts only unreferenced LRU entries and revokes each URL once", () =>
    Effect.gen(function* () {
      const h = yield* setup(
        { open: () => Effect.succeed(attempt(Stream.make(start(), bytes(), end))) },
        3,
      );
      const visible = yield* h.cache.acquire(resource("visible"));
      const older = yield* h.cache.acquire(resource("older"));
      older.release();
      const newer = yield* h.cache.acquire(resource("newer"));
      newer.release();
      expect(h.revoked).toEqual([older.url]);
      expect(h.revoked).not.toContain(visible.url);
      const touch = yield* h.cache.acquire(resource("newer"));
      touch.release();
      visible.release();
      expect(h.revoked).toEqual([older.url, newer.url]);
      yield* h.cache.dispose();
      yield* h.cache.dispose();
      visible.release();
      newer.release();
      expect(h.revoked).toEqual([older.url, newer.url, visible.url]);
    }),
  );

  it.effect("drops a failed attempt's partial bytes before a port-authorized reissue", () =>
    Effect.gen(function* () {
      let retries = 0;
      const next = attempt(Stream.make(start(), bytes(0, "ZGVm"), end));
      const h = yield* setup({
        open: () =>
          Effect.succeed({
            events: Stream.make(start(), bytes(0, "YQ==")).pipe(
              Stream.concat(
                Stream.fail(
                  new AssetTooLargeError({
                    resource: resource(),
                    limitBytes: 0,
                    message: "test retry seam",
                  }),
                ),
              ),
            ),
            retryAfter: () =>
              Effect.sync(() => {
                retries += 1;
                return next;
              }),
          }),
      });
      const lease = yield* h.cache.acquire(resource());
      expect(retries).toBe(1);
      expect(new Uint8Array(yield* Effect.promise(() => h.created[0]!.arrayBuffer()))).toEqual(
        new Uint8Array([100, 101, 102]),
      );
      lease.release();
    }),
  );

  it.effect(
    "disposal fences new and late acquisitions, joins producers and revokes completed entries",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const cleaning = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        const h = yield* setup({
          open: (item) =>
            Effect.succeed(
              attempt(
                item._tag === "attachment" && item.attachmentId === "pending"
                  ? Stream.fromEffect(Deferred.succeed(entered, undefined)).pipe(
                      Stream.drain,
                      Stream.concat(Stream.never),
                      Stream.ensuring(
                        Deferred.succeed(cleaning, undefined).pipe(
                          Effect.andThen(Deferred.await(gate)),
                        ),
                      ),
                    )
                  : Stream.make(start(), bytes(), end),
              ),
            ),
        });
        const lease = yield* h.cache.acquire(resource());
        const pending = yield* h.cache.acquire(resource("pending")).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const dispose = yield* h.cache.dispose().pipe(Effect.forkChild);
        yield* Deferred.await(cleaning);
        expect(dispose.pollUnsafe()).toBeUndefined();
        expect(Exit.isFailure(yield* Effect.exit(h.cache.acquire(resource("new"))))).toBe(true);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(dispose);
        yield* Fiber.await(pending);
        lease.release();
        expect(h.created).toHaveLength(1);
        expect(h.revoked).toEqual([lease.url]);
      }),
  );
});
