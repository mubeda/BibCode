// @effect-diagnostics globalDate:off - The gate measures the real owned request against the product's unchanged threshold.
import type { BrowserFollowupSlowReceipt } from "./release-visual-browser-followups-source.ts";

export const browserFollowupSlowThresholdMs = 15_000;
const refused = () => new Error("Owned browser follow-up transport refused.");

/** Original plain WebSocket records only. The product continues to own RPC encoding and state. */
export function createBrowserFollowupReplyGate(
  input: {
    now?: () => number;
    observeOriginal?: (
      direction: "request" | "reply",
      value: Readonly<Record<string, unknown>>,
    ) => void;
  } = {},
) {
  const now = input.now ?? Date.now;
  let clientPending = Buffer.alloc(0),
    serverPending = Buffer.alloc(0);
  let armed = false,
    closed = false,
    released = false;
  let request: { id: string; started: number } | null = null;
  let held: Buffer | null = null;
  const fail = (): never => {
    closed = true;
    clientPending = Buffer.alloc(0);
    serverPending = Buffer.alloc(0);
    held = null;
    throw refused();
  };
  const push = (bytes: Buffer, client: boolean): readonly Buffer[] => {
    if (closed || !Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 1_048_576)
      return fail();
    let pending = Buffer.concat([client ? clientPending : serverPending, bytes]);
    const result: Buffer[] = [];
    let count = 0;
    while (pending.length >= 2) {
      if (++count > 256) return fail();
      const first = pending[0]!,
        second = pending[1]!,
        opcode = first & 15,
        masked = (second & 128) !== 0;
      if (
        (first & 0x70) !== 0 ||
        (first & 128) === 0 ||
        masked !== client ||
        ![1, 8, 9, 10].includes(opcode)
      )
        return fail();
      let length = second & 127,
        header = 2;
      if (length === 127) {
        if (pending.length < 10) break;
        const long = pending.readBigUInt64BE(2);
        if (long < 65536n || long > 1_048_576n) return fail();
        length = Number(long);
        header = 10;
      } else if (length === 126) {
        if (pending.length < 4) break;
        length = pending.readUInt16BE(2);
        header = 4;
        if (length < 126) return fail();
      }
      if (opcode !== 1 && length > 125) return fail();
      const total = header + (masked ? 4 : 0) + length;
      if (pending.length < total) break;
      const record = Buffer.from(pending.subarray(0, total));
      pending = pending.subarray(total);
      if (opcode !== 1) {
        result.push(record);
        if (opcode === 8) {
          closed = true;
          held = null;
          pending = Buffer.alloc(0);
          break;
        }
        continue;
      }
      const body = Buffer.from(record.subarray(header + (masked ? 4 : 0)));
      if (masked)
        for (let i = 0; i < body.length; i++) body[i] = body[i]! ^ record[header + (i % 4)]!;
      let decoded: unknown;
      try {
        decoded = JSON.parse(body.toString("utf8"));
      } catch {
        return fail();
      }
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return fail();
      const value = decoded as Record<string, unknown>;
      input.observeOriginal?.(client ? "request" : "reply", value);
      if (
        client &&
        armed &&
        value._tag === "Request" &&
        value.tag === "server.getTraceDiagnostics"
      ) {
        if (
          request !== null ||
          typeof value.id !== "string" ||
          !/^[0-9]{1,16}$/.test(value.id) ||
          value.payload === null ||
          typeof value.payload !== "object" ||
          Array.isArray(value.payload) ||
          Object.keys(value.payload).length !== 0
        )
          return fail();
        const started = now();
        if (!Number.isFinite(started) || started < 0) return fail();
        request = { id: value.id, started };
      }
      if (
        !client &&
        request !== null &&
        !released &&
        value._tag === "Exit" &&
        value.requestId === request.id
      ) {
        const exit = value.exit as { _tag?: unknown; value?: unknown } | null;
        if (held !== null || exit?._tag !== "Success" || exit.value === undefined) return fail();
        held = record;
      } else result.push(record);
    }
    if (pending.length > 1_048_590) return fail();
    if (client) clientPending = Buffer.from(pending);
    else serverPending = Buffer.from(pending);
    return result;
  };
  return {
    arm: () => {
      if (closed || armed || request !== null || released) return fail();
      armed = true;
    },
    client: (bytes: Buffer) => push(bytes, true),
    server: (bytes: Buffer) => push(bytes, false),
    verifyHeld: (): BrowserFollowupSlowReceipt => {
      const elapsed = request === null ? -1 : now() - request.started;
      if (
        closed ||
        released ||
        !armed ||
        request === null ||
        held === null ||
        !Number.isFinite(elapsed) ||
        elapsed <= browserFollowupSlowThresholdMs ||
        elapsed > 60_000
      )
        throw refused();
      return {
        requestObserved: true,
        originalReplyHeld: true,
        elapsedBeyondThreshold: true,
        method: "server.getTraceDiagnostics",
        thresholdMs: 15000,
      };
    },
    release: (): readonly Buffer[] => {
      if (closed || released || request === null || held === null) throw refused();
      released = true;
      const result = [held];
      held = null;
      return result;
    },
    close: () => {
      closed = true;
      clientPending = Buffer.alloc(0);
      serverPending = Buffer.alloc(0);
      held = null;
    },
    observation: () => ({
      armed,
      closed,
      released,
      requestObserved: request !== null,
      replyHeld: held !== null,
      retainedBytes: (held?.length ?? 0) + clientPending.length + serverPending.length,
    }),
  };
}
