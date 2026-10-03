// @effect-diagnostics nodeBuiltinImport:off - Development-only receiver hashes disposable fixture bytes.
// @effect-diagnostics globalTimers:off - Self-contained probe owns and clears its deadline and sampler.
import * as NodeCrypto from "node:crypto";

export interface NativeInlineObservation {
  readonly complete: boolean;
  readonly messageBytes: number;
  readonly messageFinished: boolean;
  readonly messageDigest: string | null;
  readonly nativePongMidMessage: number;
  readonly nativePongAfterMessage: number;
  readonly nativePingWritesMidMessage: number;
  readonly closeFrameReceived: boolean;
  readonly closeAfterMessage: boolean;
  readonly partialFrame: boolean;
}

/** RFC 6455 attribution for one known plain message; never usable for opaque Noise/RPC attribution. */
export function createNativeFrameRecorder(expectedBytes: number, expectedDigest: string) {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 1 ||
    expectedBytes > 4 * 1024 ** 2 ||
    !/^[a-f0-9]{64}$/.test(expectedDigest)
  )
    throw new Error("Inline probe input refused.");
  const hash = NodeCrypto.createHash("sha256");
  const header = Buffer.alloc(14);
  const control = Buffer.alloc(125);
  let headerBytes = 0,
    headerNeeded = 2,
    remaining = 0,
    offset = 0,
    opcode = 0,
    final = false;
  let messageStarted = false,
    ended = false,
    frames = 0;
  const observed = {
    complete: true,
    messageBytes: 0,
    messageFinished: false,
    messageDigest: null as string | null,
    nativePongMidMessage: 0,
    nativePongAfterMessage: 0,
    nativePingWritesMidMessage: 0,
    closeFrameReceived: false,
    closeAfterMessage: false,
    partialFrame: false,
  };
  const fail = () => {
    observed.complete = false;
  };
  const finishFrame = () => {
    if (++frames > 8192) return fail();
    if (opcode === 0 || opcode === 1) {
      if (final) {
        observed.messageFinished = true;
        observed.messageDigest = hash.digest("hex");
        if (observed.messageBytes !== expectedBytes || observed.messageDigest !== expectedDigest)
          fail();
      }
    } else if (opcode === 10) {
      const matches =
        offset === 4 &&
        control[0] === 17 &&
        control[1] === 0 &&
        control[2] === 17 &&
        control[3] === 0;
      if (
        !matches ||
        observed.nativePingWritesMidMessage !== 1 ||
        observed.nativePongAfterMessage + observed.nativePongMidMessage !== 0
      )
        return fail();
      if (observed.messageFinished) observed.nativePongAfterMessage++;
      else observed.nativePongMidMessage++;
    } else {
      if (offset !== 2 || control[0] !== 3 || control[1] !== 232) return fail();
      observed.closeFrameReceived = true;
      observed.closeAfterMessage = observed.messageFinished;
    }
    headerBytes = 0;
    headerNeeded = 2;
    offset = 0;
  };
  return {
    push(bytes: Uint8Array) {
      if (ended || !observed.complete) return;
      let cursor = 0;
      while (cursor < bytes.length && observed.complete) {
        if (observed.closeFrameReceived) return fail();
        if (remaining === 0) {
          while (cursor < bytes.length && headerBytes < headerNeeded) {
            header[headerBytes++] = bytes[cursor++]!;
            if (headerBytes === 2) {
              const size = header[1]! & 127;
              headerNeeded = 6 + (size === 126 ? 2 : size === 127 ? 8 : 0);
              if ((header[0]! & 0x70) !== 0 || (header[1]! & 128) === 0) return fail();
              opcode = header[0]! & 15;
              final = (header[0]! & 128) !== 0;
              if (![0, 1, 8, 10].includes(opcode) || (opcode >= 8 && (!final || size > 125)))
                return fail();
            }
          }
          if (headerBytes !== headerNeeded) return;
          const size = header[1]! & 127;
          const length =
            size === 126
              ? header.readUInt16BE(2)
              : size === 127
                ? Number(header.readBigUInt64BE(2))
                : size;
          if (
            !Number.isSafeInteger(length) ||
            length > (opcode >= 8 ? 125 : expectedBytes) ||
            (size === 126 && length < 126) ||
            (size === 127 && length < 65536)
          )
            return fail();
          if (opcode === 1) {
            if (messageStarted || observed.messageFinished) return fail();
            messageStarted = true;
          } else if (opcode === 0 && (!messageStarted || observed.messageFinished)) return fail();
          if ((opcode === 0 || opcode === 1) && observed.messageBytes + length > expectedBytes)
            return fail();
          remaining = length;
          offset = 0;
          if (remaining === 0) {
            finishFrame();
            continue;
          }
        }
        const count = Math.min(remaining, bytes.length - cursor, 65536);
        const decoded = Buffer.allocUnsafe(count);
        for (let i = 0; i < count; i++)
          decoded[i] = bytes[cursor + i]! ^ header[headerNeeded - 4 + ((offset + i) % 4)]!;
        if (opcode === 0 || opcode === 1) {
          hash.update(decoded);
          observed.messageBytes += count;
        } else decoded.copy(control, offset);
        cursor += count;
        remaining -= count;
        offset += count;
        if (remaining === 0) finishFrame();
      }
    },
    recordPingWrite() {
      if (ended || !observed.complete) return;
      if (!messageStarted || observed.messageFinished || observed.nativePingWritesMidMessage !== 0)
        return fail();
      observed.nativePingWritesMidMessage = 1;
    },
    end() {
      if (ended) return;
      ended = true;
      observed.partialFrame = headerBytes !== 0 || remaining !== 0;
      if (observed.partialFrame || !observed.messageFinished || !observed.closeFrameReceived)
        fail();
    },
    read(): NativeInlineObservation {
      return { ...observed, partialFrame: headerBytes !== 0 || remaining !== 0 };
    },
  };
}

export type BrowserInlineAction = "mid-message-pong" | "queued-before-close";
export interface BrowserInlineObservation {
  readonly action: BrowserInlineAction | "refused";
  readonly failed: boolean;
  readonly sentBytes: number;
  readonly bufferedAfterSend: number | null;
  readonly bufferedBeforeClose: number | null;
  readonly closeCalled: boolean;
  readonly receivedCloseCode: number | null;
  readonly receivedCleanClose: boolean;
  readonly samples: ReadonlyArray<{ readonly elapsedMs: number; readonly bufferedBytes: number }>;
}
export interface BrowserInlineProgress {
  readonly action: BrowserInlineObservation["action"];
  readonly finished: boolean;
  readonly failed: boolean;
  readonly timedOut: boolean;
  readonly readyState: "unavailable" | "connecting" | "open" | "closing" | "closed";
  readonly sentBytes: number;
  readonly bufferedBytes: number | null;
  readonly closeCalled: boolean;
  readonly receivedCloseCode: number | null;
  readonly receivedCleanClose: boolean;
  readonly sampleCount: number;
}

/** Self-contained WebDriver executeAsync boundary: fixed endpoint and payload, closed observations only. */
export function runBrowserInlineMechanics(
  action: BrowserInlineAction,
  done: (value: BrowserInlineObservation) => void,
  progress?: (value: BrowserInlineProgress) => void,
): void {
  const started = performance.now();
  const result = {
    action:
      action === "mid-message-pong" || action === "queued-before-close"
        ? action
        : ("refused" as const),
    failed: false,
    sentBytes: 0,
    bufferedAfterSend: null as number | null,
    bufferedBeforeClose: null as number | null,
    closeCalled: false,
    receivedCloseCode: null as number | null,
    receivedCleanClose: false,
    samples: [] as Array<{ elapsedMs: number; bufferedBytes: number }>,
  };
  let socket: WebSocket | undefined,
    finished = false,
    timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined,
    sampleTimer: ReturnType<typeof setInterval> | undefined;
  const publish = () => {
    try {
      const buffered = socket?.bufferedAmount;
      progress?.({
        action: result.action,
        finished,
        failed: result.failed,
        timedOut,
        readyState:
          socket?.readyState === 0
            ? "connecting"
            : socket?.readyState === 1
              ? "open"
              : socket?.readyState === 2
                ? "closing"
                : socket?.readyState === 3
                  ? "closed"
                  : "unavailable",
        sentBytes: result.sentBytes,
        bufferedBytes:
          Number.isSafeInteger(buffered) && buffered! >= 0 && buffered! <= 4194304
            ? buffered!
            : null,
        closeCalled: result.closeCalled,
        receivedCloseCode: result.receivedCloseCode,
        receivedCleanClose: result.receivedCleanClose,
        sampleCount: result.samples.length,
      });
    } catch {
      // A diagnostic callback cannot change the action, terminal result or owned cleanup.
    }
  };
  const sample = () => {
    const buffered = socket?.bufferedAmount;
    const elapsedMs = Math.round(performance.now() - started);
    if (
      !Number.isSafeInteger(buffered) ||
      buffered! < 0 ||
      buffered! > 4 * 1024 ** 2 ||
      !Number.isSafeInteger(elapsedMs) ||
      elapsedMs < 0 ||
      elapsedMs > 250000
    ) {
      result.failed = true;
      publish();
      return;
    }
    if (result.samples.length < 256) result.samples.push({ elapsedMs, bufferedBytes: buffered! });
    else result.failed = true;
    publish();
  };
  const finish = (failed: boolean) => {
    if (finished) return;
    finished = true;
    result.failed ||= failed;
    // Capture the terminal cause and state before the existing cleanup close.
    publish();
    clearTimeout(timer);
    clearInterval(sampleTimer);
    try {
      if (socket && socket.readyState < 2) socket.close(1000);
    } catch {
      result.failed = true;
    }
    done(result);
  };
  if (action !== "mid-message-pong" && action !== "queued-before-close") {
    finish(true);
    return;
  }
  try {
    socket = new WebSocket("ws://127.0.0.1:4917/inline-probe");
    publish();
    timer = setTimeout(() => {
      timedOut = true;
      finish(true);
    }, 240000);
    socket.onopen = () => {
      try {
        socket!.send("A".repeat(3 * 1024 ** 2));
        result.sentBytes = 3 * 1024 ** 2;
        sample();
        result.bufferedAfterSend = socket!.bufferedAmount;
        sampleTimer = setInterval(sample, 1000);
        if (action === "queued-before-close") {
          result.bufferedBeforeClose = socket!.bufferedAmount;
          socket!.close(1000);
          result.closeCalled = true;
          publish();
        }
      } catch {
        finish(true);
      }
    };
    socket.onclose = (event) => {
      result.receivedCloseCode = event.code;
      result.receivedCleanClose = event.wasClean;
      finish(false);
    };
    socket.onerror = () => finish(true);
  } catch {
    finish(true);
  }
}

/** One inert observer per document; only the explicit remaining profile starts it. */
export const browserInlineMechanicsScript = `;(() => {
  let started = false, result = null, progress = null;
  const probe = (${runBrowserInlineMechanics.toString()});
  Object.defineProperty(window, "__inlineMechanics", { value: {
    start(action) { if (started) throw new Error("Inline probe already started."); started = true; probe(action, value => { result = value; }, value => { progress = value; }); },
    read() { return result; },
    progress() { return progress; }
  }});
})();`;
