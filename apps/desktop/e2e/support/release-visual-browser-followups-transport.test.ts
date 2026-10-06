// @effect-diagnostics nodeBuiltinImport:off - Inert original wire bytes exercise the capture transport boundary.
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
