import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { scheduleRender } from "./renderQueue";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("render queue", () => {
  it("runs one job per task, the most recently scheduled first", () => {
    const order: string[] = [];
    for (const name of ["first", "second", "third"]) {
      scheduleRender(
        () => name,
        (value) => order.push(value),
      );
    }

    expect(order).toEqual([]);
    vi.advanceTimersToNextTimer();
    expect(order).toEqual(["third"]);
    vi.advanceTimersToNextTimer();
    expect(order).toEqual(["third", "second"]);
    vi.advanceTimersToNextTimer();
    expect(order).toEqual(["third", "second", "first"]);
  });

  it("drops a cancelled job that has not run", () => {
    const run = vi.fn(() => 1);
    const done = vi.fn();
    const cancel = scheduleRender(run, done);
    cancel();
    cancel();
    vi.runAllTimers();

    expect(run).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });

  it("passes a throwing job's error to its failure callback and keeps running others", () => {
    const failure = new Error("boom");
    const fail = vi.fn();
    const done = vi.fn();
    scheduleRender(() => "later", done);
    scheduleRender(
      () => {
        throw failure;
      },
      () => undefined,
      fail,
    );
    vi.runAllTimers();

    expect(fail).toHaveBeenCalledWith(failure);
    expect(done).toHaveBeenCalledWith("later");
  });

  it("drops a throwing job without a failure callback", () => {
    const done = vi.fn();
    scheduleRender(() => {
      throw new Error("ignored");
    }, done);
    scheduleRender(() => "next", done);
    vi.runAllTimers();

    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith("next");
  });
});
