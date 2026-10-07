// @effect-diagnostics globalDate:off - The gate measures the real owned request against the product's unchanged threshold.
// @effect-diagnostics nodeBuiltinImport:off - QA loads the same installed RPC serialization as the public contract consumer.
import * as NodeModule from "node:module";
import {
  RecordAssembler,
  E2EE_RECORD_FLAG_CONTROL,
} from "../../../../packages/client-runtime/src/e2ee/frame.ts";
import type { BrowserFollowupSlowReceipt } from "./release-visual-browser-followups-source.ts";
const serialization: {
  json: { makeUnsafe: () => { decode: (bytes: Uint8Array) => readonly unknown[] } };
} = NodeModule.createRequire(
  new URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/unstable/rpc/RpcSerialization");
export const browserFollowupSlowThresholdMs = 15_000;
const refused = () => new Error("Owned browser follow-up transport refused.");
const chunkedProtocol = "bibcode.rpc.chunked.v1";
/** Decode logical RPC using maintained helpers; every forwarded/held frame stays original. */
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
    released = false,
    selected = false,
    framesSeen = false;
  let mode: "whole-text" | "chunked-v1" = "whole-text";
  let request: { id: string; started: number } | null = null;
  let held: Buffer[] | null = null;
  let clientAssembler: RecordAssembler | null = null,
    serverAssembler: RecordAssembler | null = null;
  let clientMessageBytes = 0,
    serverMessageBytes = 0,
    serverMessageOpen = false;
  let stageCandidate = false,
    stage: Buffer[] = [],
    stageBytes = 0;
  const parser = serialization.json.makeUnsafe();
  const clear = () => {
    clientPending = Buffer.alloc(0);
    serverPending = Buffer.alloc(0);
    held = null;
    clientAssembler = null;
    serverAssembler = null;
    stage = [];
    stageBytes = 0;
    clientMessageBytes = 0;
    serverMessageBytes = 0;
    serverMessageOpen = false;
  };
  const fail = (): never => {
    closed = true;
    clear();
    throw refused();
  };
  const logical = (
    decoded: unknown,
    records: Buffer[],
    forwarded: boolean,
    client: boolean,
    result: Buffer[],
  ) => {
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return fail();
    const value = decoded as Record<string, unknown>;
    try {
      input.observeOriginal?.(client ? "request" : "reply", value);
    } catch (error) {
      closed = true;
      clear();
      throw error;
    }
    if (client && armed && value._tag === "Request" && value.tag === "server.getTraceDiagnostics") {
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
      if (held !== null || forwarded || exit?._tag !== "Success" || exit.value === undefined)
        return fail();
      held = records;
    } else if (!forwarded) result.push(...records);
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
        ![1, 2, 8, 9, 10].includes(opcode) ||
        (opcode === 2 && mode !== "chunked-v1")
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
      if (opcode >= 8 && length > 125) return fail();
      const total = header + (masked ? 4 : 0) + length;
      if (pending.length < total) break;
      framesSeen = true;
      const record = Buffer.from(pending.subarray(0, total));
      pending = pending.subarray(total);
      if (opcode >= 8) {
        result.push(record);
        if (opcode === 8) {
          closed = true;
          clear();
          pending = Buffer.alloc(0);
          break;
        }
        continue;
      }
      const body = Buffer.from(record.subarray(header + (masked ? 4 : 0)));
      if (masked)
        for (let i = 0; i < body.length; i++) body[i] = body[i]! ^ record[header + (i % 4)]!;
      if (opcode === 1) {
        let decoded: unknown;
        try {
          decoded = JSON.parse(body.toString("utf8"));
        } catch {
          return fail();
        }
        logical(decoded, [record], false, client, result);
        continue;
      }
      const assembler = client ? clientAssembler : serverAssembler;
      if (!assembler) return fail();
      const control = body[0] === E2EE_RECORD_FLAG_CONTROL;
      if (!client && !control && !serverMessageOpen) stageCandidate = request !== null && !released;
      if (!client && !control && stageCandidate) {
        stage.push(record);
        stageBytes += record.length;
        if (stageBytes > 1_048_590) return fail();
      }
      let message: Uint8Array | null;
      try {
        message = assembler.push(body);
      } catch {
        return fail();
      }
      if (!control) {
        if (client) clientMessageBytes += Math.max(0, body.length - 1);
        else {
          serverMessageBytes += Math.max(0, body.length - 1);
          serverMessageOpen = message === null;
        }
      }
      const forwarded = !control && (client || !stageCandidate);
      if (forwarded) result.push(record);
      if (message === null) continue;
      let values: readonly unknown[];
      try {
        values = parser.decode(message);
      } catch {
        return fail();
      }
      if (values.length !== 1) return fail();
      const records = control || client || !stageCandidate ? [record] : stage;
      logical(values[0], records, forwarded, client, result);
      if (!control) {
        if (client) clientMessageBytes = 0;
        else {
          serverMessageBytes = 0;
          stage = [];
          stageBytes = 0;
          stageCandidate = false;
        }
      }
    }
    if (pending.length > 1_048_590) return fail();
    if (client) clientPending = Buffer.from(pending);
    else serverPending = Buffer.from(pending);
    return result;
  };
  const verifyHeld = (): BrowserFollowupSlowReceipt => {
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
  };
  return {
    selectProtocol: (offered: readonly string[], protocol: string | null) => {
      if (
        closed ||
        selected ||
        framesSeen ||
        (protocol !== null && (protocol !== chunkedProtocol || !offered.includes(protocol)))
      )
        return fail();
      selected = true;
      if (protocol === chunkedProtocol) {
        mode = "chunked-v1";
        clientAssembler = new RecordAssembler(1_048_576, { allowControlRecords: true });
        serverAssembler = new RecordAssembler(1_048_576, { allowControlRecords: true });
      }
    },
    arm: () => {
      if (closed || armed || request !== null || released) return fail();
      armed = true;
    },
    client: (bytes: Buffer) => push(bytes, true),
    server: (bytes: Buffer) => push(bytes, false),
    verifyHeld,
    release: (): readonly Buffer[] => {
      verifyHeld();
      if (held === null) throw refused();
      released = true;
      const result = held;
      held = null;
      return result;
    },
    close: () => {
      closed = true;
      clear();
    },
    observation: () => ({
      armed,
      closed,
      released,
      requestObserved: request !== null,
      replyHeld: held !== null,
      retainedBytes:
        (held?.reduce((total, record) => total + record.length, 0) ?? 0) +
        clientPending.length +
        serverPending.length +
        clientMessageBytes +
        serverMessageBytes +
        stageBytes,
    }),
  };
}
