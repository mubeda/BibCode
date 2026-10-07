// @effect-diagnostics nodeBuiltinImport:off - Inert original wire bytes exercise the capture transport boundary.
import * as NodeModule from "node:module";
import {
  plaintextRecords,
  E2EE_RECORD_FLAG_CONTROL,
} from "../../../../packages/client-runtime/src/e2ee/frame.ts";
import { expect, it } from "vite-plus/test";
import { createBrowserFollowupReplyGate } from "./release-visual-browser-followups-transport.ts";

function frame(value: unknown, masked = false): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(body.length < 126 ? 2 : 4);
  header[0] = 0x81;
  header[1] = (masked ? 128 : 0) + (body.length < 126 ? body.length : 126);
  if (body.length >= 126) header.writeUInt16BE(body.length, 2);
  if (!masked) return Buffer.concat([header, body]);
  const key = Buffer.from([7, 11, 19, 23]);
  const encoded = Buffer.from(body);
  for (let i = 0; i < encoded.length; i++) encoded[i] = encoded[i]! ^ key[i % 4]!;
  return Buffer.concat([header, key, encoded]);
}
const request = (id: string) =>
  frame({ _tag: "Request", id, tag: "server.getTraceDiagnostics", payload: {}, headers: [] }, true);
const response = (id: string) =>
  frame({ _tag: "Exit", requestId: id, exit: { _tag: "Success", value: { spanCount: 3 } } });

it("retains only the genuine selected response and releases its original bytes after the real threshold", () => {
  let now = 100;
  const gate = createBrowserFollowupReplyGate({ now: () => now });
  gate.arm();
  const sent = request("7");
  expect(Buffer.concat(gate.client(sent))).toEqual(sent);
  expect(Buffer.concat(gate.server(response("unrelated")))).toEqual(response("unrelated"));
  const bytes = response("7");
  expect(gate.server(bytes.subarray(0, 5))).toEqual([]);
  expect(gate.server(bytes.subarray(5))).toEqual([]);
  now += 15000;
  expect(() => gate.verifyHeld()).toThrow();
  now++;
  expect(gate.verifyHeld()).toEqual({
    requestObserved: true,
    originalReplyHeld: true,
    elapsedBeyondThreshold: true,
    method: "server.getTraceDiagnostics",
    thresholdMs: 15000,
  });
  expect(Buffer.concat(gate.release())).toEqual(bytes);
  expect(gate.observation().released).toBe(true);
  gate.close();
  expect(gate.observation().retainedBytes).toBe(0);
});

it.each(["binary", "duplicate", "bad-clock", "closed", "failure"])(
  "refuses unowned or unusable %s wire state",
  (mode) => {
    let now = 100;
    const gate = createBrowserFollowupReplyGate({ now: () => now });
    gate.arm();
    gate.client(request("7"));
    if (mode === "binary") {
      const bytes = response("7");
      bytes[0] = 0x82;
      expect(() => gate.server(bytes)).toThrow();
    } else if (mode === "duplicate") expect(() => gate.client(request("8"))).toThrow();
    else if (mode === "closed") {
      gate.close();
      expect(() => gate.verifyHeld()).toThrow();
    } else if (mode === "failure")
      expect(() =>
        gate.server(frame({ _tag: "Exit", requestId: "7", exit: { _tag: "Failure", cause: [] } })),
      ).toThrow();
    else {
      gate.server(response("7"));
      now = 99;
      expect(() => gate.verifyHeld()).toThrow();
    }
  },
);

it("admits only negotiated maintained binary RPC records and retains the original wire bytes", () => {
  const seen: unknown[] = [];
  const gate = createBrowserFollowupReplyGate({
    observeOriginal: (_direction, value) => seen.push(value),
  });
  gate.selectProtocol(["bibcode.rpc.chunked.v1"], "bibcode.rpc.chunked.v1");
  const body = Buffer.concat([Buffer.from([0]), Buffer.from('{"_tag":"Ping"}')]);
  const wire = Buffer.concat([Buffer.from([0x82, body.length]), body]);
  expect(Buffer.concat(gate.server(wire))).toEqual(wire);
  expect(seen).toEqual([{ _tag: "Ping" }]);
});

const maintainedJson: { encode: (value: unknown) => string } = NodeModule.createRequire(
  new URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/unstable/rpc/RpcSerialization").json.makeUnsafe();
function wireFrame(body: Uint8Array, opcode = 2, masked = false): Buffer {
  const header = Buffer.alloc(body.length < 126 ? 2 : body.length < 65536 ? 4 : 10);
  header[0] = 128 | opcode;
  header[1] =
    (masked ? 128 : 0) | (body.length < 126 ? body.length : body.length < 65536 ? 126 : 127);
  if (header.length === 4) header.writeUInt16BE(body.length, 2);
  if (header.length === 10) header.writeBigUInt64BE(BigInt(body.length), 2);
  const payload = Buffer.from(body),
    key = Buffer.from([7, 11, 19, 23]);
  if (masked) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ key[i % 4]!;
  return Buffer.concat(masked ? [header, key, payload] : [header, payload]);
}
function originalRecords(value: unknown, masked = false): Buffer[] {
  return [...plaintextRecords(Buffer.from(maintainedJson.encode(value)))].map((record) =>
    wireFrame(record, 2, masked),
  );
}
it("holds the complete original selected data sequence while independent RPC and WebSocket controls remain original", () => {
  let now = 100;
  const seen: unknown[] = [];
  const gate = createBrowserFollowupReplyGate({
    now: () => now,
    observeOriginal: (_direction, value) => seen.push(value),
  });
  gate.selectProtocol(["bibcode.rpc.chunked.v1"], "bibcode.rpc.chunked.v1");
  gate.arm();
  expect(gate.client(request("7"))).toEqual([request("7")]);
  const selected = {
    _tag: "Exit",
    requestId: "7",
    exit: { _tag: "Success", value: { content: "x".repeat(140000) } },
  };
  const records = originalRecords(selected);
  expect(records.length).toBeGreaterThan(2);
  expect(gate.server(records[0]!)).toEqual([]);
  const independent = { _tag: "Pong" };
  const control = wireFrame(
    Buffer.concat([
      Buffer.from([E2EE_RECORD_FLAG_CONTROL]),
      Buffer.from(maintainedJson.encode(independent)),
    ]),
  );
  const ping = wireFrame(Buffer.from("owned"), 9);
  expect(gate.server(Buffer.concat([control, ping]))).toEqual([control, ping]);
  for (const record of records.slice(1)) {
    expect(gate.server(record.subarray(0, 3))).toEqual([]);
    expect(gate.server(record.subarray(3))).toEqual([]);
  }
  expect(seen).toEqual([
    { _tag: "Request", id: "7", tag: "server.getTraceDiagnostics", payload: {}, headers: [] },
    independent,
    selected,
  ]);
  now += 15000;
  expect(() => gate.release()).toThrow();
  now++;
  expect(gate.verifyHeld().originalReplyHeld).toBe(true);
  expect(gate.release()).toEqual(records);
  expect(() => gate.release()).toThrow();
  gate.close();
  expect(gate.observation().retainedBytes).toBe(0);
});
it("forwards unarmed continuation/control/final records in their original byte order and observes each logical envelope once", () => {
  const seen: unknown[] = [],
    gate = createBrowserFollowupReplyGate({
      observeOriginal: (_direction, value) => seen.push(value),
    });
  gate.selectProtocol(["bibcode.rpc.chunked.v1"], "bibcode.rpc.chunked.v1");
  const value = { _tag: "Chunk", requestId: "2", values: [{ content: "x".repeat(140000) }] };
  const records = originalRecords(value),
    pong = { _tag: "Pong" };
  const control = wireFrame(
    Buffer.concat([
      Buffer.from([E2EE_RECORD_FLAG_CONTROL]),
      Buffer.from(maintainedJson.encode(pong)),
    ]),
  );
  const input = Buffer.concat([records[0]!, control, ...records.slice(1)]);
  expect(Buffer.concat(gate.server(input))).toEqual(input);
  expect(seen).toEqual([pong, value]);
});
it("keeps absent selection and negotiated text on the unchanged whole-text byte path", () => {
  for (const selected of [null, "bibcode.rpc.chunked.v1"]) {
    const gate = createBrowserFollowupReplyGate();
    gate.selectProtocol(selected === null ? [] : [selected], selected);
    const text = frame({ _tag: "Ping" }, true);
    expect(gate.client(text.subarray(0, 1))).toEqual([]);
    expect(Buffer.concat(gate.client(text.subarray(1)))).toEqual(text);
  }
});
it.each(["unsolicited", "unsupported", "case", "repeat", "late"])(
  "refuses %s protocol admission",
  (mode) => {
    const gate = createBrowserFollowupReplyGate();
    if (mode === "repeat") gate.selectProtocol([], null);
    if (mode === "late") gate.server(frame({ _tag: "Ping" }));
    expect(() =>
      gate.selectProtocol(
        mode === "unsolicited" ? [] : ["bibcode.rpc.chunked.v1"],
        mode === "unsupported"
          ? "foreign.v1"
          : mode === "case"
            ? "BIBCODE.rpc.chunked.v1"
            : "bibcode.rpc.chunked.v1",
      ),
    ).toThrow();
    expect(gate.observation().closed).toBe(true);
  },
);
it.each([
  "empty",
  "unknown",
  "empty-continuation",
  "oversized-control",
  "malformed-json",
  "batch",
  "rsv",
  "unmasked",
  "ws-control",
])("refuses unusable %s records without a logical proof", (mode) => {
  const gate = createBrowserFollowupReplyGate();
  gate.selectProtocol(["bibcode.rpc.chunked.v1"], "bibcode.rpc.chunked.v1");
  let record = wireFrame(Buffer.from([3, 123]));
  if (mode === "empty") record = wireFrame(Buffer.alloc(0));
  if (mode === "empty-continuation") record = wireFrame(Buffer.from([1]));
  if (mode === "oversized-control")
    record = wireFrame(Buffer.concat([Buffer.from([2]), Buffer.alloc(65535)]));
  if (mode === "malformed-json") record = wireFrame(Buffer.from([0, 123]));
  if (mode === "batch")
    record = wireFrame(
      Buffer.concat([Buffer.from([0]), Buffer.from('[{"_tag":"Ping"},{"_tag":"Pong"}]')]),
    );
  if (mode === "rsv") {
    record = originalRecords({ _tag: "Ping" })[0]!;
    record[0] = record[0]! | 0x40;
  }
  if (mode === "unmasked") {
    expect(() => gate.client(originalRecords({ _tag: "Ping" })[0]!)).toThrow();
    return;
  }
  if (mode === "ws-control") record = wireFrame(Buffer.alloc(126), 9);
  expect(() => gate.server(record)).toThrow();
  expect(gate.observation().closed).toBe(true);
  expect(gate.observation().retainedBytes).toBe(0);
});
it("refuses an incomplete or overflowing logical record without extending the existing bound", () => {
  const gate = createBrowserFollowupReplyGate();
  gate.selectProtocol(["bibcode.rpc.chunked.v1"], "bibcode.rpc.chunked.v1");
  const first = originalRecords({ content: "x".repeat(140000) })[0]!;
  gate.server(first);
  expect(gate.observation().retainedBytes).toBeGreaterThan(0);
  gate.close();
  expect(gate.observation().retainedBytes).toBe(0);
  const other = createBrowserFollowupReplyGate();
  other.selectProtocol(["bibcode.rpc.chunked.v1"], "bibcode.rpc.chunked.v1");
  const oversized = originalRecords({ content: "x".repeat(1100000) });
  expect(() => {
    for (const record of oversized) other.server(record);
  }).toThrow();
  expect(other.observation().retainedBytes).toBe(0);
});
it("preserves an observer's original exception and retires its buffered wire state", () => {
  const original = new Error("Inert observer refusal");
  const gate = createBrowserFollowupReplyGate({
    observeOriginal: () => {
      throw original;
    },
  });
  gate.selectProtocol(["bibcode.rpc.chunked.v1"], "bibcode.rpc.chunked.v1");
  expect(() => gate.server(originalRecords({ _tag: "Ping" })[0]!)).toThrow(original);
  expect(gate.observation()).toMatchObject({ closed: true, retainedBytes: 0 });
});
