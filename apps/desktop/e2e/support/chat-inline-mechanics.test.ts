// @effect-diagnostics nodeBuiltinImport:off - Inert qualification tests stream owned bytes without sockets.
import * as NodeCrypto from "node:crypto";
import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import {
  createNativeFrameRecorder,
  runBrowserInlineMechanics,
  browserInlineMechanicsScript,
  type BrowserInlineObservation,
} from "./chat-inline-mechanics.ts";

const digest = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
// Hand-written masked RFC 6455 frames. Only fixtures retain their own payload.
function frame(opcode: number, payload: Uint8Array, final = true) {
  const extended = payload.length < 126 ? 0 : payload.length < 65536 ? 2 : 8;
  const bytes = Buffer.alloc(6 + extended + payload.length);
  bytes[0] = (final ? 128 : 0) | opcode;
  bytes[1] = 128 | (extended === 0 ? payload.length : extended === 2 ? 126 : 127);
  if (extended === 2) bytes.writeUInt16BE(payload.length, 2);
  if (extended === 8) bytes.writeBigUInt64BE(BigInt(payload.length), 2);
  const mask = [23, 8, 17, 1];
  bytes.set(mask, 2 + extended);
  for (let i = 0; i < payload.length; i++) bytes[6 + extended + i] = payload[i]! ^ mask[i % 4]!;
  return bytes;
}
const pong = frame(10, Uint8Array.from([17, 0, 17, 0]));
const close = frame(8, Uint8Array.from([3, 232]));

describe("native inline mechanics attribution", () => {
  it("hashes fragmented data and attributes a native Pong only while the message is incomplete", () => {
    const payload = Buffer.from("abcdef");
    const recorder = createNativeFrameRecorder(6, digest(payload));
    for (const byte of frame(1, payload.subarray(0, 3), false)) recorder.push(Uint8Array.of(byte));
    recorder.recordPingWrite();
    for (const byte of pong) recorder.push(Uint8Array.of(byte));
    recorder.push(frame(0, payload.subarray(3)));
    recorder.push(close);
    recorder.end();
    expect(recorder.read()).toMatchObject({
      complete: true,
      messageBytes: 6,
      messageFinished: true,
      messageDigest: "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721",
      nativePingWritesMidMessage: 1,
      nativePongMidMessage: 1,
      nativePongAfterMessage: 0,
      closeFrameReceived: true,
      closeAfterMessage: true,
      partialFrame: false,
    });
  });

  it("does not claim interleaving when the automatic Pong arrives behind one complete frame", () => {
    const payload = Buffer.alloc(65536, 65);
    const wire = frame(1, payload);
    const recorder = createNativeFrameRecorder(payload.length, digest(payload));
    recorder.push(wire.subarray(0, 1024));
    recorder.recordPingWrite();
    recorder.push(wire.subarray(1024));
    recorder.push(pong);
    recorder.push(close);
    recorder.end();
    expect(recorder.read()).toMatchObject({
      complete: true,
      messageBytes: 65536,
      nativePingWritesMidMessage: 1,
      nativePongMidMessage: 0,
      nativePongAfterMessage: 1,
      closeAfterMessage: true,
    });
  });

  it("reports a cut frame as partial and fences bytes retained after end", () => {
    const payload = Buffer.from("abc");
    const recorder = createNativeFrameRecorder(3, digest(payload));
    const wire = frame(1, payload);
    recorder.push(wire.subarray(0, -1));
    recorder.end();
    const before = recorder.read();
    recorder.push(wire);
    recorder.recordPingWrite();
    expect(recorder.read()).toEqual(before);
    expect(before).toMatchObject({
      complete: false,
      partialFrame: true,
      messageFinished: false,
      closeFrameReceived: false,
    });
  });

  it.each([
    Uint8Array.of(0x81, 3, 65, 65, 65),
    Uint8Array.of(0xc1, 0x80, 0, 0, 0, 0),
    Uint8Array.of(0x09, 0x80, 0, 0, 0, 0),
    Uint8Array.of(0x81, 0xfe, 0, 1, 0, 0, 0, 0),
    Uint8Array.of(0x81, 0xff, 0x80, 0, 0, 0, 0, 0, 0, 0),
  ])(
    "refuses unsupported, unmasked, noncanonical or oversized headers without payload guessing",
    (wire) => {
      const recorder = createNativeFrameRecorder(3, digest(Buffer.from("abc")));
      recorder.push(wire);
      recorder.end();
      expect(recorder.read().complete).toBe(false);
      expect(recorder.read().closeFrameReceived).toBe(false);
    },
  );

  it("refuses mismatched final data independently of native controls", () => {
    const recorder = createNativeFrameRecorder(3, digest(Buffer.from("abc")));
    recorder.push(frame(1, Buffer.from("abd")));
    expect(recorder.read().complete).toBe(false);
    expect(recorder.read().nativePongMidMessage).toBe(0);
  });
  it("reaches and refuses an unmatched Pong during a valid incomplete message", () => {
    const recorder = createNativeFrameRecorder(6, digest(Buffer.from("abcdef")));
    recorder.push(frame(1, Buffer.from("abc"), false));
    recorder.recordPingWrite();
    expect(recorder.read()).toMatchObject({
      complete: true,
      messageFinished: false,
      nativePingWritesMidMessage: 1,
    });
    recorder.push(frame(10, Buffer.from("private-pong")));
    expect(recorder.read()).toMatchObject({ complete: false, nativePongMidMessage: 0 });
    expect(JSON.stringify(recorder.read())).not.toContain("private-pong");
  });
  it("refuses an unsolicited matching Pong while valid message data remains incomplete", () => {
    const recorder = createNativeFrameRecorder(6, digest(Buffer.from("abcdef")));
    recorder.push(frame(1, Buffer.from("abc"), false));
    expect(recorder.read().complete).toBe(true);
    recorder.push(pong);
    expect(recorder.read()).toMatchObject({ complete: false, nativePongMidMessage: 0 });
  });
  it("refuses a duplicate matching Pong after the first attributed control", () => {
    const recorder = createNativeFrameRecorder(6, digest(Buffer.from("abcdef")));
    recorder.push(frame(1, Buffer.from("abc"), false));
    recorder.recordPingWrite();
    recorder.push(pong);
    expect(recorder.read()).toMatchObject({ complete: true, nativePongMidMessage: 1 });
    recorder.push(pong);
    expect(recorder.read()).toMatchObject({ complete: false, nativePongMidMessage: 1 });
  });
});

function browserFixture(action: unknown, installer = false) {
  let socket: Socket | undefined, done: BrowserInlineObservation | undefined;
  const callbacks = new Map<number, () => void>();
  let next = 0;
  class Socket {
    readonly url: string;
    readyState = 0;
    bufferedAmount = 0;
    sentBytes = 0;
    closeCodes: number[] = [];
    onopen?: () => void;
    onclose?: (event: { code: number; wasClean: boolean }) => void;
    onerror?: () => void;
    constructor(url: string) {
      this.url = url;
      socket = this;
    }
    send(value: string) {
      this.sentBytes = value.length;
      this.bufferedAmount = value.length;
    }
    close(code: number) {
      this.closeCodes.push(code);
      this.readyState = 2;
    }
  }
  const schedule = (fn: () => void) => {
    callbacks.set(++next, fn);
    return next;
  };
  const page = {} as {
    __inlineMechanics: { start(action: string): void; read(): BrowserInlineObservation | null };
  };
  NodeVM.runInNewContext(
    installer
      ? browserInlineMechanicsScript
      : `(${runBrowserInlineMechanics.toString()})(action, done)`,
    {
      window: page,
      action,
      done: (value: BrowserInlineObservation) => (done = value),
      performance: { now: () => 0 },
      WebSocket: Socket,
      setTimeout: schedule,
      setInterval: schedule,
      clearTimeout: (id: number) => callbacks.delete(id),
      clearInterval: (id: number) => callbacks.delete(id),
    },
  );
  return {
    get socket() {
      return socket;
    },
    read: () => (installer ? page.__inlineMechanics.read() : done),
    callbacks,
    page,
  };
}
describe("closed browser mechanics callback", () => {
  it("keeps installation inert and admits one explicit action per document", () => {
    const f = browserFixture(null, true);
    expect(f.socket).toBeUndefined();
    expect(f.read()).toBeNull();
    f.page.__inlineMechanics.start("queued-before-close");
    expect(f.socket).toBeDefined();
    expect(() => f.page.__inlineMechanics.start("mid-message-pong")).toThrow(
      "Inline probe already started.",
    );
    f.socket!.readyState = 1;
    f.socket!.onopen!();
    f.socket!.onclose!({ code: 1000, wasClean: true });
    expect(f.read()).toMatchObject({
      action: "queued-before-close",
      failed: false,
      sentBytes: 3145728,
    });
    expect(f.callbacks.size).toBe(0);
  });
  it("samples the actual browser queue before the one explicit close and joins its timers", () => {
    const f = browserFixture("queued-before-close");
    f.socket!.readyState = 1;
    f.socket!.onopen!();
    expect(f.socket!.closeCodes).toEqual([1000]);
    f.socket!.onclose!({ code: 1000, wasClean: true });
    expect(f.read()).toMatchObject({
      action: "queued-before-close",
      failed: false,
      sentBytes: 3145728,
      bufferedAfterSend: 3145728,
      bufferedBeforeClose: 3145728,
      closeCalled: true,
      receivedCloseCode: 1000,
      receivedCleanClose: true,
    });
    expect(f.callbacks.size).toBe(0);
    f.socket!.onerror!();
    expect(f.read()!.failed).toBe(false);
  });
  it("leaves the mid-message probe open for native receiver controls without claiming browser-visible Pong", () => {
    const f = browserFixture("mid-message-pong");
    f.socket!.readyState = 1;
    f.socket!.onopen!();
    expect(f.socket!.sentBytes).toBe(3145728);
    expect(f.socket!.closeCodes).toEqual([]);
    f.socket!.readyState = 3;
    f.socket!.onclose!({ code: 1000, wasClean: true });
    expect(f.read()).toMatchObject({
      closeCalled: false,
      bufferedBeforeClose: null,
      receivedCloseCode: 1000,
    });
    expect(Object.keys(f.read()!)).toEqual([
      "action",
      "failed",
      "sentBytes",
      "bufferedAfterSend",
      "bufferedBeforeClose",
      "closeCalled",
      "receivedCloseCode",
      "receivedCleanClose",
      "samples",
    ]);
  });
  it("rejects an invalid action without opening a socket", () => {
    const f = browserFixture("private-invalid");
    expect(f.socket).toBeUndefined();
    expect(f.read()!.failed).toBe(true);
    expect(JSON.stringify(f.read())).not.toContain("private-invalid");
  });
});
