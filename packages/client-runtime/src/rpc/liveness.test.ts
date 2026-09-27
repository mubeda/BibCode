import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Random from "effect/Random";
import * as TestClock from "effect/testing/TestClock";

import { makeInboundActivity, runLivenessMonitor } from "./liveness.ts";

const withRandom =
  (value: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Random.Random, {
        nextDoubleUnsafe: () => value,
        nextIntUnsafe: () => 0,
      }),
    );

describe("runLivenessMonitor", () => {
  it.effect("pings after each silent interval and gives up after three", () =>
    Effect.gen(function* () {
      const activity = yield* makeInboundActivity;
      let pings = 0;
      const monitor = yield* Effect.forkChild(
        runLivenessMonitor({
          activity,
          sendPing: Effect.sync(() => {
            pings += 1;
          }),
        }),
      );
      yield* TestClock.adjust("9999 millis");
      expect(pings).toBe(0);
      yield* TestClock.adjust("1 millis");
      expect(pings).toBe(1);
      yield* TestClock.adjust("10 seconds");
      expect(pings).toBe(2);
      expect(monitor.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(monitor)).toBe(30_000);
      expect(pings).toBe(2);
    }).pipe(withRandom(0.5)),
  );

  it.effect("restarts the silent period at the latest inbound message", () =>
    Effect.gen(function* () {
      const activity = yield* makeInboundActivity;
      let pings = 0;
      const monitor = yield* Effect.forkChild(
        runLivenessMonitor({
          activity,
          sendPing: Effect.sync(() => {
            pings += 1;
          }),
        }),
      );
      yield* TestClock.adjust("5 seconds");
      activity.record();
      yield* TestClock.adjust("9 seconds");
      expect(pings).toBe(0);
      yield* TestClock.adjust("1 second");
      expect(pings).toBe(1);
      yield* TestClock.adjust("20 seconds");
      expect(yield* Fiber.join(monitor)).toBe(30_000);
    }).pipe(withRandom(0.5)),
  );

  it.effect("declares death no earlier than 27 seconds of silence", () =>
    Effect.gen(function* () {
      const activity = yield* makeInboundActivity;
      const monitor = yield* Effect.forkChild(
        runLivenessMonitor({ activity, sendPing: Effect.void }),
      );
      yield* TestClock.adjust("26999 millis");
      expect(monitor.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 millis");
      expect(yield* Fiber.join(monitor)).toBe(27_000);
    }).pipe(withRandom(0)),
  );

  it.effect("declares death no later than 33 seconds of silence", () =>
    Effect.gen(function* () {
      const activity = yield* makeInboundActivity;
      const monitor = yield* Effect.forkChild(
        runLivenessMonitor({ activity, sendPing: Effect.void }),
      );
      yield* TestClock.adjust("32999 millis");
      expect(monitor.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 millis");
      expect(yield* Fiber.join(monitor)).toBe(33_000);
    }).pipe(withRandom(0.999_999)),
  );

  it.effect("counts silence from reset when the socket opens", () =>
    Effect.gen(function* () {
      const activity = yield* makeInboundActivity;
      yield* TestClock.adjust("7 seconds");
      activity.reset();
      const monitor = yield* Effect.forkChild(
        runLivenessMonitor({ activity, sendPing: Effect.void }),
      );
      yield* TestClock.adjust("29 seconds");
      expect(monitor.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(monitor)).toBe(30_000);
    }).pipe(withRandom(0.5)),
  );
});

describe("makeInboundActivity", () => {
  it.effect("awaitAfter completes at the next recorded message", () =>
    Effect.gen(function* () {
      const activity = yield* makeInboundActivity;
      const waiting = yield* Effect.forkChild(activity.awaitAfter(activity.sequence()));
      yield* Effect.yieldNow;
      expect(waiting.pollUnsafe()).toBeUndefined();
      activity.record();
      yield* Fiber.join(waiting);
      yield* activity.awaitAfter(0);
    }),
  );
});
