export interface TerminalInputSendResult {
  readonly ok: boolean;
  readonly error?: unknown;
}

/**
 * Who produced a piece of input: a renderer's size claim for a user's input, `null` for the
 * terminal's own replies, `undefined` for unmarked input. Input of different origins never
 * shares a frame (#348).
 */
export type TerminalInputSchedulerOrigin = string | null | undefined;

export interface TerminalInputSchedulerOptions {
  /** Sends one payload to the PTY. Resolves ok:false or rejects to signal failure. */
  readonly send: (
    data: string,
    origin: TerminalInputSchedulerOrigin,
  ) => Promise<TerminalInputSendResult>;
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
  enqueue(data: string, origin?: TerminalInputSchedulerOrigin): void;
  /**
   * Reserves the current end of the queue for input that is not ready yet. Later
   * input waits behind the reservation, within the pending limit, until the returned
   * function fills it (`null` leaves nothing). A reservation from before a reset or
   * failure is ignored.
   */
  reserve(origin?: TerminalInputSchedulerOrigin): (data: string | null) => void;
  /** Drops pending input and invalidates in-flight results for the old generation. */
  reset(): void;
  pendingLength(): number;
  isDraining(): boolean;
}

export const DEFAULT_MAX_INPUT_FRAME_LENGTH = 16 * 1024;
export const BRACKETED_PASTE_START = "\u001b[200~";
export const BRACKETED_PASTE_END = "\u001b[201~";

export interface TerminalInputSegment {
  readonly kind: "ordinary" | "paste";
  readonly data: string;
}

/**
 * Partitions terminal input in strict stream order into ordinary text and complete
 * `\x1b[200~...\x1b[201~` bracketed-paste envelopes. Unclosed openers stay ordinary so raw escape
 * sequences are never trapped in staged paste assembly.
 */
export function partitionTerminalInputSegments(data: string): TerminalInputSegment[] {
  if (data.length === 0) return [];
  if (!data.includes(BRACKETED_PASTE_START)) {
    return [{ kind: "ordinary", data }];
  }
  const segments: TerminalInputSegment[] = [];
  let cursor = 0;
  while (cursor < data.length) {
    const startIdx = data.indexOf(BRACKETED_PASTE_START, cursor);
    if (startIdx === -1) {
      segments.push({ kind: "ordinary", data: data.slice(cursor) });
      break;
    }
    const endIdx = data.indexOf(BRACKETED_PASTE_END, startIdx + BRACKETED_PASTE_START.length);
    if (endIdx === -1) {
      segments.push({ kind: "ordinary", data: data.slice(cursor) });
      break;
    }
    if (startIdx > cursor) {
      segments.push({ kind: "ordinary", data: data.slice(cursor, startIdx) });
    }
    const pasteEnd = endIdx + BRACKETED_PASTE_END.length;
    segments.push({ kind: "paste", data: data.slice(startIdx, pasteEnd) });
    cursor = pasteEnd;
  }
  return segments;
}

function matchBracketedPasteDelimiter(data: string, index: number): number {
  if (data.charCodeAt(index) !== 0x1b) return 0;
  if (
    data.startsWith(BRACKETED_PASTE_START, index) ||
    data.startsWith(BRACKETED_PASTE_END, index)
  ) {
    return BRACKETED_PASTE_START.length;
  }
  return 0;
}

function takeDelimiterSafePrefixLength(
  data: string,
  maxFrameLength: number,
  maxFrameBytes: number,
): number {
  let index = 0;
  let frameChars = 0;
  let frameBytes = 0;
  while (index < data.length) {
    const delimiterLen = matchBracketedPasteDelimiter(data, index);
    let unitLen: number;
    let unitBytes: number;
    if (delimiterLen > 0) {
      unitLen = delimiterLen;
      unitBytes = delimiterLen;
    } else {
      const codePoint = data.codePointAt(index)!;
      unitLen = codePoint > 0xffff ? 2 : 1;
      unitBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    }
    if (
      frameChars > 0 &&
      (frameChars + unitLen > maxFrameLength || frameBytes + unitBytes > maxFrameBytes)
    ) {
      break;
    }
    index += unitLen;
    frameChars += unitLen;
    frameBytes += unitBytes;
  }
  return index;
}

/**
 * Splits `data` into UTF-8 and surrogate-pair safe frames without ever splitting a 6-byte
 * `\x1b[200~` or `\x1b[201~` bracketed-paste delimiter across a frame boundary.
 */
export function sliceDelimiterSafeFrames(
  data: string,
  maxFrameLength = DEFAULT_MAX_INPUT_FRAME_LENGTH,
  maxFrameBytes = 16 * 1024,
): string[] {
  const frames: string[] = [];
  let cursor = 0;
  while (cursor < data.length) {
    const end = takeDelimiterSafePrefixLength(
      cursor === 0 ? data : data.slice(cursor),
      maxFrameLength,
      maxFrameBytes,
    );
    frames.push(data.slice(cursor, cursor + end));
    cursor += end;
  }
  return frames;
}

export function createTerminalInputScheduler(
  options: TerminalInputSchedulerOptions,
): TerminalInputScheduler {
  const requestedMaxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_INPUT_FRAME_LENGTH;
  const maxFrameLength = Number.isFinite(requestedMaxFrameLength)
    ? Math.max(1, Math.floor(requestedMaxFrameLength))
    : DEFAULT_MAX_INPUT_FRAME_LENGTH;
  interface Segment {
    data: string;
    readonly origin: TerminalInputSchedulerOrigin;
  }
  // Pending input in arrival order; adjacent input of one origin shares a segment.
  let pending: Segment[] = [];
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
  interface Reservation {
    data: string | null;
    filled: boolean;
    readonly origin: TerminalInputSchedulerOrigin;
  }
  // Input waiting behind the first unfilled reservation, in arrival order.
  let held: Array<Segment | Reservation> = [];
  let reservationEpoch = 0;

  const append = (data: string, origin: TerminalInputSchedulerOrigin) => {
    const last = pending.at(-1);
    if (last !== undefined && last.origin === origin) last.data += data;
    else pending.push({ data, origin });
  };

  const takeFrame = (): Segment => {
    const head = pending[0]!;
    const startIdx = head.data.indexOf(BRACKETED_PASTE_START);
    let end: number;
    if (startIdx !== -1) {
      const endIdx = head.data.indexOf(
        BRACKETED_PASTE_END,
        startIdx + BRACKETED_PASTE_START.length,
      );
      if (endIdx !== -1) {
        if (startIdx === 0) {
          // Deliver the complete bracketed-paste envelope intact so downstream transport can
          // stage it atomically (ordered) or send up to 64 KiB in a single write (legacy).
          end = endIdx + BRACKETED_PASTE_END.length;
        } else {
          // Ordinary text before the opener stays separate from the bracketed paste.
          end = takeDelimiterSafePrefixLength(
            head.data.slice(0, startIdx),
            maxFrameLength,
            maxFrameBytes,
          );
        }
      } else {
        end = takeDelimiterSafePrefixLength(head.data, maxFrameLength, maxFrameBytes);
      }
    } else {
      end = takeDelimiterSafePrefixLength(head.data, maxFrameLength, maxFrameBytes);
    }

    const frame = { data: head.data.slice(0, end), origin: head.origin };
    head.data = head.data.slice(end);
    if (head.data.length === 0) pending.shift();
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
    pending = [];
    held = [];
    reservationEpoch += 1;
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
          const result = await options.send(frame.data, frame.origin);
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

  const queuedText = () => [...pending, ...held].map((item) => item.data ?? "").join("");
  const exceedsPending = (data: string) =>
    encoder.encode(queuedText() + data).length > maxPendingBytes;
  const failOverflow = () =>
    fail(
      new Error("Terminal input exceeded the 1 MiB pending limit. Reattach before typing again."),
    );

  const releaseFilled = () => {
    while (held.length > 0) {
      const head = held[0]!;
      if ("filled" in head && !head.filled) break;
      held.shift();
      if (head.data) append(head.data, head.origin);
    }
    if (pending.length > 0) scheduleDrain();
  };

  return {
    enqueue(data, origin) {
      if (data.length === 0 || stopped) return;
      if (exceedsPending(data)) {
        failOverflow();
        return;
      }
      if (held.length > 0) {
        held.push({ data, origin });
        return;
      }
      append(data, origin);
      scheduleDrain();
    },
    reserve(origin) {
      const reservation: Reservation = { data: null, filled: false, origin };
      const epoch = reservationEpoch;
      held.push(reservation);
      return (data) => {
        if (reservation.filled || epoch !== reservationEpoch) return;
        if (data !== null && exceedsPending(data)) {
          failOverflow();
          return;
        }
        reservation.data = data;
        reservation.filled = true;
        releaseFilled();
      };
    },
    reset() {
      generation += 1;
      pending = [];
      held = [];
      reservationEpoch += 1;
      stopped = false;
      if (maxInFlight() > 1) inFlight.clear();
      notifyReset();
    },
    pendingLength() {
      return pending.reduce((length, segment) => length + segment.data.length, 0);
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
