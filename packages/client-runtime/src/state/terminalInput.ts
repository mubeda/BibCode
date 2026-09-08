export interface TerminalInputSendResult {
  readonly ok: boolean;
  readonly error?: unknown;
}

export interface TerminalInputSchedulerOptions {
  /** Sends one payload to the PTY. Resolves ok:false or rejects to signal failure. */
  readonly send: (data: string) => Promise<TerminalInputSendResult>;
  /**
   * Invoked once when a current-generation write fails, after dependent input is
   * dropped. Observer exceptions are isolated from the scheduler.
   */
  readonly onWriteError?: (error: unknown) => void;
  /** Maximum UTF-16 length of a single RPC frame. */
  readonly maxFrameLength?: number;
  readonly maxInFlight?: number | (() => number);
  readonly maxFrameBytes?: number;
  readonly maxPendingBytes?: number;
  readonly stopOnError?: boolean | (() => boolean);
  readonly onReset?: () => void;
}

export interface TerminalInputScheduler {
  /** Appends input in arrival order and schedules a drain. Empty strings are ignored. */
  enqueue(data: string): void;
  /** Drops pending input and invalidates in-flight results for the old generation. */
  reset(): void;
  pendingLength(): number;
  isDraining(): boolean;
}

export const DEFAULT_MAX_INPUT_FRAME_LENGTH = 16 * 1024;

export function createTerminalInputScheduler(
  options: TerminalInputSchedulerOptions,
): TerminalInputScheduler {
  const requestedMaxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_INPUT_FRAME_LENGTH;
  const maxFrameLength = Number.isFinite(requestedMaxFrameLength)
    ? Math.max(1, Math.floor(requestedMaxFrameLength))
    : DEFAULT_MAX_INPUT_FRAME_LENGTH;
  let pending = "";
  const maxInFlight = () =>
    Math.max(
      1,
      Math.min(
        16,
        Math.floor(
          typeof options.maxInFlight === "function"
            ? options.maxInFlight()
            : (options.maxInFlight ?? 1),
        ) || 1,
      ),
    );
  const maxFrameBytes = Math.max(
    4,
    Math.min(16 * 1024, Math.floor(options.maxFrameBytes ?? 16 * 1024) || 16 * 1024),
  );
  const maxPendingBytes = Math.max(
    1,
    Math.min(1024 * 1024, Math.floor(options.maxPendingBytes ?? 1024 * 1024) || 1024 * 1024),
  );
  const encoder = new TextEncoder();
  const inFlight = new Set<object>();
  let stopped = false;
  let scheduled = false;
  let generation = 0;

  const takeFrame = (): string => {
    let end = 0;
    let bytes = 0;
    for (const character of pending) {
      const size = terminalInputCharacterBytes(character);
      if (end > 0 && (end + character.length > maxFrameLength || bytes + size > maxFrameBytes))
        break;
      end += character.length;
      bytes += size;
    }

    const frame = pending.slice(0, end);
    pending = pending.slice(end);
    return frame;
  };

  const notifyWriteError = (error: unknown): void => {
    try {
      options.onWriteError?.(error);
    } catch {
      // Error observers are isolated from the scheduler lifecycle.
    }
  };

  const notifyReset = (): void => {
    try {
      options.onReset?.();
    } catch {
      /* Lifecycle observers cannot break draining. */
    }
  };

  const fail = (error: unknown): void => {
    pending = "";
    if (typeof options.stopOnError === "function" ? options.stopOnError() : options.stopOnError) {
      stopped = true;
      notifyReset();
    }
    notifyWriteError(error);
  };

  const drain = (): void => {
    if (stopped) return;
    while (pending.length > 0 && inFlight.size < maxInFlight()) {
      const frameGeneration = generation;
      const frame = takeFrame();
      const token = {};
      inFlight.add(token);
      void (async () => {
        try {
          const result = await options.send(frame);
          if (frameGeneration === generation && !result.ok && !stopped) fail(result.error);
        } catch (error) {
          if (frameGeneration === generation && !stopped) fail(error);
        } finally {
          if (inFlight.delete(token)) {
            drain();
          }
        }
      })();
    }
  };

  const scheduleDrain = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      drain();
    });
  };

  return {
    enqueue(data) {
      if (data.length === 0 || stopped) return;
      if (encoder.encode(pending + data).length > maxPendingBytes) {
        fail(
          new Error(
            "Terminal input exceeded the 1 MiB pending limit. Reattach before typing again.",
          ),
        );
        return;
      }
      pending += data;
      scheduleDrain();
    },
    reset() {
      generation += 1;
      pending = "";
      stopped = false;
      if (maxInFlight() > 1) inFlight.clear();
      notifyReset();
    },
    pendingLength() {
      return pending.length;
    },
    isDraining() {
      return inFlight.size > 0;
    },
  };
}

export interface TerminalInputSchedulerRegistry {
  /** Returns the scheduler for `key`, creating it with `factory` on first use. */
  acquire(key: string, factory: () => TerminalInputScheduler): TerminalInputScheduler;
  /** Resets and removes the scheduler for `key`. Call when the terminal session is closed. */
  release(key: string): void;
  size(): number;
}

export function createTerminalInputSchedulerRegistry(): TerminalInputSchedulerRegistry {
  const schedulers = new Map<string, TerminalInputScheduler>();

  return {
    acquire(key, factory) {
      const existing = schedulers.get(key);
      if (existing !== undefined) return existing;

      const created = factory();
      schedulers.set(key, created);
      return created;
    },
    release(key) {
      schedulers.get(key)?.reset();
      schedulers.delete(key);
    },
    size() {
      return schedulers.size;
    },
  };
}

// Key derivation only: JSON tuples keep component boundaries collision-safe.
export function terminalInputKey(
  environmentId: string,
  threadId: string,
  terminalId: string,
): string {
  return JSON.stringify([environmentId, threadId, terminalId]);
}

/** The UTF-8 encoding width of one for-of Unicode character. */
export function terminalInputCharacterBytes(character: string): number {
  const codePoint = character.codePointAt(0)!;
  return codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
}
