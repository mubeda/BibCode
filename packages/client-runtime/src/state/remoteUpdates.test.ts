import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type RemoteUpdateSnapshot } from "@bibcode/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import type { AtomCommandResult } from "./runtime.ts";
import {
  MAX_CONCURRENT_REMOTE_UPDATE_CHECKS,
  REMOTE_UPDATE_CHECK_TIMEOUT_MS,
  fanOutRemoteUpdateChecks,
  isRemoteUpdateAvailable,
  withRemoteUpdateCheckTimeout,
} from "./remoteUpdates.ts";

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const settledSuccess = <A>(value: A): AtomCommandResult<A, never> =>
  ({ _tag: "Success", value }) as unknown as AtomCommandResult<A, never>;
const settledFailure = <E>(error: E): AtomCommandResult<never, E> =>
  ({ _tag: "Failure", cause: { error } }) as unknown as AtomCommandResult<never, E>;

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
  it.effect("interrupts a check and fails it after thirty seconds", () =>
    Effect.gen(function* () {
      expect(REMOTE_UPDATE_CHECK_TIMEOUT_MS).toBe(30_000);
      const fiber = yield* Effect.forkChild(withRemoteUpdateCheckTimeout(Effect.never));

      yield* TestClock.adjust("29 seconds");
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 second");

      const timeout = yield* Fiber.join(fiber).pipe(Effect.flip);
      expect(timeout._tag).toBe("TimeoutError");
    }),
  );
});

describe("isRemoteUpdateAvailable", () => {
  const base: RemoteUpdateSnapshot = {
    serverVersion: "0.4.2",
    latestVersion: "0.5.0",
    state: "update-available",
    error: null,
    support: { installMode: "interactive", reason: "available" },
  };

  it("is true only for update-available snapshots", () => {
    expect(isRemoteUpdateAvailable(base)).toBe(true);
    expect(isRemoteUpdateAvailable({ ...base, state: "up-to-date" })).toBe(false);
    expect(isRemoteUpdateAvailable({ ...base, state: "error" })).toBe(false);
    expect(isRemoteUpdateAvailable(null)).toBe(false);
  });
});
