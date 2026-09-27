import { useSyncExternalStore } from "react";

const MINUTE_MS = 60_000;

export interface MinuteClockEnvironment {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  /** Calls `listener` when the page becomes visible; returns the unsubscribe function. */
  readonly onVisibilityChange: (listener: () => void) => () => void;
}

export interface MinuteClock {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => number;
}

/**
 * One app-wide clock for relative ages. While anything is subscribed it keeps a
 * single timer aligned to the next minute boundary, and re-reads the time when
 * the page becomes visible again; at zero subscribers it stops completely.
 */
export function createMinuteClock(environment: MinuteClockEnvironment): MinuteClock {
  const listeners = new Set<() => void>();
  let snapshot = environment.now();
  let timer: unknown = null;
  let stopVisibility: (() => void) | null = null;

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const schedule = () => {
    if (timer !== null) {
      environment.clearTimeout(timer);
    }
    const now = environment.now();
    timer = environment.setTimeout(tick, MINUTE_MS - (now % MINUTE_MS));
  };

  function tick() {
    timer = null;
    snapshot = environment.now();
    notify();
    if (listeners.size > 0) {
      schedule();
    }
  }

  const onVisible = () => {
    snapshot = environment.now();
    notify();
    // Notification may synchronously remove the final subscriber.
    if (listeners.size > 0) {
      schedule();
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        snapshot = environment.now();
        schedule();
        stopVisibility = environment.onVisibilityChange(onVisible);
      }
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) {
          return;
        }
        if (timer !== null) {
          environment.clearTimeout(timer);
          timer = null;
        }
        stopVisibility?.();
        stopVisibility = null;
      };
    },
    getSnapshot: () => snapshot,
  };
}

const browserEnvironment: MinuteClockEnvironment = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  onVisibilityChange: (listener) => {
    if (typeof document === "undefined") {
      return () => {};
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        listener();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  },
};

export const appMinuteClock = createMinuteClock(browserEnvironment);

/** The current minute-resolution time; re-renders the caller once per minute. */
export function useMinuteClock(): number {
  return useSyncExternalStore(
    appMinuteClock.subscribe,
    appMinuteClock.getSnapshot,
    appMinuteClock.getSnapshot,
  );
}
