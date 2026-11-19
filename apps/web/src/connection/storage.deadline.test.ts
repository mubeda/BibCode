import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach, vi } from "vite-plus/test";

import {
  deleteIncompatibleConnectionDatabase,
  getConnectionDatabaseHealth,
  resetConnectionDatabaseHealthForTest,
} from "./databaseHealth";
import { connectionStorageLayer, makeCatalogBackend } from "./storage";

const DEADLINE_MS = 10_000;

/** An IndexedDB request or transaction that fires only what the test fires. */
class SilentTarget extends EventTarget {
  result: unknown = undefined;
  error: unknown = null;
  readonly abort = vi.fn();
  fire(type: string): void {
    this.dispatchEvent(new Event(type));
  }
}

/** A database whose transactions and requests settle only when the test settles them. */
function silentDatabase() {
  const transactions: SilentTarget[] = [];
  const requests: SilentTarget[] = [];
  const close = vi.fn();
  const request = () => {
    const created = new SilentTarget();
    requests.push(created);
    return created;
  };
  const database = {
    addEventListener: () => undefined,
    close,
    transaction: () => {
      const transaction = new SilentTarget();
      transactions.push(transaction);
      return Object.assign(transaction, { objectStore: () => ({ get: request, put: request }) });
    },
  } as unknown as IDBDatabase;
  return { database, transactions, requests, close };
}

/** An `indexedDB` whose open request never fires an event on its own. */
function installSilentOpen() {
  const requests: SilentTarget[] = [];
  vi.stubGlobal("indexedDB", {
    open: () => {
      const request = new SilentTarget();
      requests.push(request);
      return request;
    },
  });
  return requests;
}

const start = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.forkDetach(effect, { startImmediately: true });
const advance = (ms: number) => Effect.promise(() => vi.advanceTimersByTimeAsync(ms));

function failureText(fiber: Fiber.Fiber<unknown, unknown>): string {
  const exit = fiber.pollUnsafe();
  expect(exit, "the request was still waiting").toBeDefined();
  expect(Exit.isFailure(exit!)).toBe(true);
  return Exit.isFailure(exit!) ? String(exit.cause) : "";
}

const buildStorage = Effect.scoped(Layer.build(connectionStorageLayer));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("window", {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetConnectionDatabaseHealthForTest();
});

describe("connection storage deadlines", () => {
  it.effect("fails an open that fires no event and reports that the store did not answer", () =>
    Effect.gen(function* () {
      installSilentOpen();
      const build = yield* start(buildStorage);

      yield* advance(DEADLINE_MS - 1);
      expect(build.pollUnsafe()).toBeUndefined();
      yield* advance(1);

      expect(failureText(build)).toContain("did not answer");
      expect(getConnectionDatabaseHealth()).toMatchObject({
        status: "unavailable",
        timedOut: true,
      });
    }),
  );

  it.effect("fails a blocked open that then stays silent", () =>
    Effect.gen(function* () {
      const requests = installSilentOpen();
      const build = yield* start(buildStorage);
      yield* advance(0);
      requests[0]!.fire("blocked");
      expect(getConnectionDatabaseHealth().status).toBe("blocked");

      yield* advance(DEADLINE_MS);

      failureText(build);
      expect(getConnectionDatabaseHealth()).toMatchObject({
        status: "unavailable",
        timedOut: true,
      });
    }),
  );

  it.effect("closes an open that succeeds after its deadline and keeps the failure visible", () =>
    Effect.gen(function* () {
      const requests = installSilentOpen();
      const build = yield* start(buildStorage);
      yield* advance(DEADLINE_MS);
      failureText(build);

      const late = silentDatabase();
      requests[0]!.result = late.database;
      requests[0]!.fire("success");

      expect(late.close).toHaveBeenCalledOnce();
      expect(getConnectionDatabaseHealth()).toMatchObject({
        status: "unavailable",
        timedOut: true,
      });
    }),
  );

  it.effect("fails a read that never settles", () =>
    Effect.gen(function* () {
      const { database, transactions } = silentDatabase();
      const read = yield* start(makeCatalogBackend(database).read);

      yield* advance(DEADLINE_MS);

      expect(failureText(read)).toContain("did not answer");
      expect(transactions[0]!.abort).toHaveBeenCalledOnce();
      expect(getConnectionDatabaseHealth()).toMatchObject({
        status: "unavailable",
        timedOut: true,
      });
    }),
  );

  it.effect("fails a write that never settles as outcome unknown and ignores its late commit", () =>
    Effect.gen(function* () {
      const { database, requests, transactions } = silentDatabase();
      const write = yield* start(makeCatalogBackend(database).compareAndSet(null, "next"));
      yield* advance(0);
      // The read and the put both answer; only the transaction's commit is withheld.
      requests[0]!.result = undefined;
      requests[0]!.fire("success");
      expect(requests, "the compare-and-set reached its put").toHaveLength(2);
      requests[1]!.fire("success");

      yield* advance(DEADLINE_MS);
      const exit = write.pollUnsafe();
      expect(failureText(write)).toContain("outcome is unknown");

      transactions[0]!.fire("complete");
      yield* advance(0);

      expect(write.pollUnsafe()).toBe(exit);
      expect(getConnectionDatabaseHealth()).toMatchObject({
        status: "unavailable",
        timedOut: true,
      });
    }),
  );

  it.effect("fails an aborted write at once as not saved and keeps the store available", () =>
    Effect.gen(function* () {
      const { database, transactions } = silentDatabase();
      const write = yield* start(makeCatalogBackend(database).quarantine!("raw"));
      yield* advance(0);

      transactions[0]!.fire("abort");
      yield* advance(0);

      expect(failureText(write)).toContain("nothing was saved");
      expect(getConnectionDatabaseHealth().status).toBe("ready");
    }),
  );

  it.effect("leaves a store that answers in time unchanged", () =>
    Effect.gen(function* () {
      const { database, requests, transactions } = silentDatabase();
      const read = yield* start(makeCatalogBackend(database).read);
      yield* advance(DEADLINE_MS - 1);
      requests[0]!.result = "stored";
      requests[0]!.fire("success");
      yield* advance(DEADLINE_MS);

      expect(read.pollUnsafe()).toEqual(Exit.succeed("stored"));
      expect(transactions[0]!.abort).not.toHaveBeenCalled();
      expect(getConnectionDatabaseHealth().status).toBe("ready");
    }),
  );

  it.effect("fails a database deletion that fires no event", () =>
    Effect.gen(function* () {
      const request = new SilentTarget();
      vi.stubGlobal("indexedDB", { deleteDatabase: () => request });
      const deletion = deleteIncompatibleConnectionDatabase();
      const failure = expect(deletion).rejects.toThrow("did not answer");

      yield* advance(15_000);

      yield* Effect.promise(() => failure);
      expect(getConnectionDatabaseHealth()).toMatchObject({
        status: "unavailable",
        timedOut: true,
      });
      // A success after the deadline must not dismiss the dialog of a reset that failed.
      request.fire("success");
      expect(getConnectionDatabaseHealth()).toMatchObject({ timedOut: true });
    }),
  );
});
