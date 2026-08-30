import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type RemoteUpdateSnapshot, WS_METHODS } from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { RelayConnectionTarget } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { AtomCommandResult } from "./runtime.ts";
import {
  MAX_CONCURRENT_REMOTE_UPDATE_CHECKS,
  REMOTE_UPDATE_CHECK_TIMEOUT_MS,
  createRemoteUpdateEnvironmentAtoms,
  fanOutRemoteUpdateChecks,
  isRemoteUpdateAvailable,
} from "./remoteUpdates.ts";

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const settledSuccess = <A>(value: A): AtomCommandResult<A, never> =>
  ({ _tag: "Success", value }) as unknown as AtomCommandResult<A, never>;
const settledFailure = <E>(error: E): AtomCommandResult<never, E> =>
  ({ _tag: "Failure", cause: { error } }) as unknown as AtomCommandResult<never, E>;

const CHECKED_SNAPSHOT: RemoteUpdateSnapshot = {
  serverVersion: "0.4.2",
  latestVersion: "0.5.0",
  state: "update-available",
  error: null,
  support: { installMode: "interactive", reason: "available" },
};

const makeRemoteUpdateCommandHarness = Effect.fn("TestRemoteUpdates.makeCommandHarness")(
  function* (options: {
    readonly acquire: (environmentId: EnvironmentId) => Effect.Effect<void>;
    readonly check: (environmentId: EnvironmentId) => Effect.Effect<RemoteUpdateSnapshot>;
  }) {
    const clock = yield* TestClock.make({ warningDelay: "1 hour" });
    const atomRegistry = AtomRegistry.make();
    yield* Effect.addFinalizer(() => Effect.sync(() => atomRegistry.dispose()));

    const run: EnvironmentRegistry["Service"]["run"] = (environmentId, effect) =>
      options.acquire(environmentId).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const session = {
              client: {
                [WS_METHODS.updaterCheck]: () => options.check(environmentId),
              },
            } as unknown as RpcSession;
            const sessionRef = yield* SubscriptionRef.make(Option.some(session));
            const supervisor = EnvironmentSupervisor.of({
              target: new RelayConnectionTarget({
                environmentId,
                label: `Environment ${environmentId}`,
              }),
              session: sessionRef,
            } as EnvironmentSupervisor["Service"]);
            return yield* Effect.provideService(effect, EnvironmentSupervisor, supervisor);
          }),
        ),
      );
    const registry = EnvironmentRegistry.of({ run } as EnvironmentRegistry["Service"]);
    const runtime = Atom.runtime(
      Layer.merge(Layer.succeed(EnvironmentRegistry, registry), Layer.succeed(Clock.Clock, clock)),
    );
    return {
      atomRegistry,
      check: createRemoteUpdateEnvironmentAtoms(runtime).check,
      clock,
    };
  },
);

function expectCompletedWithTimeout(
  exit: ReturnType<Fiber.Fiber<AtomCommandResult<unknown, unknown>, never>["pollUnsafe"]>,
): void {
  expect(exit?._tag).toBe("Success");
  if (exit?._tag !== "Success") return;
  expect(exit.value._tag).toBe("Failure");
  if (exit.value._tag !== "Failure") return;
  expect(Cause.squash(exit.value.cause)).toMatchObject({ _tag: "TimeoutError" });
}

describe("fanOutRemoteUpdateChecks", () => {
  it("exports the spec-pinned limit of two", () => {
    expect(MAX_CONCURRENT_REMOTE_UPDATE_CHECKS).toBe(2);
  });

  it("never runs more than two checks at once and preserves input order", async () => {
    const ids = ["env-a", "env-b", "env-c", "env-d"].map((id) => EnvironmentId.make(id));
    const releasers = new Map<string, () => void>();
    let inFlight = 0;
    let peak = 0;

    const batch = fanOutRemoteUpdateChecks(ids, (environmentId) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise<AtomCommandResult<string, never>>((resolve) => {
        releasers.set(environmentId, () => {
          inFlight -= 1;
          resolve(settledSuccess(`checked:${environmentId}`));
        });
      });
    });

    await flushMicrotasks();
    expect(releasers.size).toBe(2);
    expect(peak).toBe(2);

    releasers.get(ids[0]!)!();
    await flushMicrotasks();
    expect(releasers.size).toBe(3);
    expect(peak).toBe(2);

    for (const release of releasers.values()) release();
    await flushMicrotasks();
    for (const release of releasers.values()) release();

    const results = await batch;
    expect(results.map((result) => result.environmentId)).toEqual(ids);
    expect(results.every((result) => result.outcome.kind === "success")).toBe(true);
    expect(peak).toBe(2);
  });

  it("classifies a settled Failure VALUE as a failure, not a success", async () => {
    const ids = ["env-a", "env-b", "env-c"].map((id) => EnvironmentId.make(id));
    const results = await fanOutRemoteUpdateChecks(ids, (environmentId) =>
      environmentId === ids[1]
        ? Promise.resolve(settledFailure("unreachable"))
        : Promise.resolve(settledSuccess("ok")),
    );
    expect(results.map((result) => result.outcome.kind)).toEqual(["success", "failure", "success"]);
    const failure = results[1]!.outcome;
    expect(failure.kind === "failure" && failure.result?._tag).toBe("Failure");
  });

  it("also isolates a thrown rejection (defensive) instead of aborting the batch", async () => {
    const ids = ["env-a", "env-b"].map((id) => EnvironmentId.make(id));
    const results = await fanOutRemoteUpdateChecks(ids, (environmentId) =>
      environmentId === ids[0]
        ? Promise.reject(new Error("dispatcher blew up"))
        : Promise.resolve(settledSuccess("ok")),
    );
    expect(results.map((result) => result.outcome.kind)).toEqual(["failure", "success"]);
    const failure = results[0]!.outcome;
    expect(failure.kind === "failure" && failure.result).toBeNull();
    expect(failure.kind === "failure" && failure.error).toBeInstanceOf(Error);
  });

  it("handles an empty environment list", async () => {
    await expect(
      fanOutRemoteUpdateChecks([], () => Promise.resolve(settledSuccess("ok"))),
    ).resolves.toEqual([]);
  });
});

describe("remote update check timeout", () => {
  it.effect("bounds supervisor acquisition and does not invoke RPC after timeout", () =>
    Effect.gen(function* () {
      expect(REMOTE_UPDATE_CHECK_TIMEOUT_MS).toBe(30_000);
      const environmentId = EnvironmentId.make("environment-acquisition-stall");
      const acquisitionStarted = yield* Deferred.make<void>();
      const rpcInvocations = yield* Ref.make(0);
      const harness = yield* makeRemoteUpdateCommandHarness({
        acquire: () =>
          Deferred.succeed(acquisitionStarted, undefined).pipe(Effect.andThen(Effect.never)),
        check: () =>
          Ref.update(rpcInvocations, (count) => count + 1).pipe(Effect.as(CHECKED_SNAPSHOT)),
      });
      const fiber = yield* Effect.promise(() =>
        harness.check.run(harness.atomRegistry, { environmentId, input: {} }),
      ).pipe(Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(acquisitionStarted);
      yield* harness.clock.adjust(REMOTE_UPDATE_CHECK_TIMEOUT_MS);
      for (let iteration = 0; iteration < 100; iteration += 1) {
        yield* Effect.yieldNow;
      }

      expectCompletedWithTimeout(fiber.pollUnsafe());
      expect(yield* Ref.get(rpcInvocations)).toBe(0);
    }),
  );

  it.effect("bounds a stalled RPC after fast supervisor acquisition", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-rpc-stall");
      const rpcStarted = yield* Deferred.make<void>();
      const harness = yield* makeRemoteUpdateCommandHarness({
        acquire: () => Effect.void,
        check: () => Deferred.succeed(rpcStarted, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const fiber = yield* Effect.promise(() =>
        harness.check.run(harness.atomRegistry, { environmentId, input: {} }),
      ).pipe(Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(rpcStarted);
      yield* harness.clock.adjust(REMOTE_UPDATE_CHECK_TIMEOUT_MS);
      for (let iteration = 0; iteration < 100; iteration += 1) {
        yield* Effect.yieldNow;
      }

      expectCompletedWithTimeout(fiber.pollUnsafe());
    }),
  );

  it.effect("releases a fan-out worker slot when supervisor acquisition times out", () =>
    Effect.gen(function* () {
      const environmentIds = ["environment-a", "environment-b", "environment-c"].map((id) =>
        EnvironmentId.make(id),
      );
      const thirdAcquisitionStarted = yield* Deferred.make<void>();
      const started = yield* Ref.make<ReadonlyArray<EnvironmentId>>([]);
      const harness = yield* makeRemoteUpdateCommandHarness({
        acquire: (environmentId) =>
          Ref.update(started, (current) => [...current, environmentId]).pipe(
            Effect.andThen(
              environmentId === environmentIds[2]
                ? Deferred.succeed(thirdAcquisitionStarted, undefined)
                : Effect.never,
            ),
          ),
        check: () => Effect.succeed(CHECKED_SNAPSHOT),
      });
      const batch = yield* Effect.promise(() =>
        fanOutRemoteUpdateChecks(environmentIds, (environmentId) =>
          harness.check.run(harness.atomRegistry, { environmentId, input: {} }),
        ),
      ).pipe(Effect.forkChild({ startImmediately: true }));

      for (let iteration = 0; iteration < 100; iteration += 1) {
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(started)).toEqual(environmentIds.slice(0, 2));

      yield* harness.clock.adjust(REMOTE_UPDATE_CHECK_TIMEOUT_MS);
      for (let iteration = 0; iteration < 100; iteration += 1) {
        yield* Effect.yieldNow;
      }

      expect(yield* Deferred.isDone(thirdAcquisitionStarted)).toBe(true);
      const exit = batch.pollUnsafe();
      expect(exit?._tag).toBe("Success");
      if (exit?._tag === "Success") {
        expect(exit.value.map((result) => result.environmentId)).toEqual(environmentIds);
        expect(exit.value.map((result) => result.outcome.kind)).toEqual([
          "failure",
          "failure",
          "success",
        ]);
      }
    }),
  );
});

describe("isRemoteUpdateAvailable", () => {
  it("is true only for update-available snapshots", () => {
    expect(isRemoteUpdateAvailable(CHECKED_SNAPSHOT)).toBe(true);
    expect(isRemoteUpdateAvailable({ ...CHECKED_SNAPSHOT, state: "up-to-date" })).toBe(false);
    expect(isRemoteUpdateAvailable({ ...CHECKED_SNAPSHOT, state: "error" })).toBe(false);
    expect(isRemoteUpdateAvailable(null)).toBe(false);
  });
});
