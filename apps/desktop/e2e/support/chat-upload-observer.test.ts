// @effect-diagnostics nodeBuiltinImport:off - Inert tests evaluate the actual passive browser installer.
import * as NodeVM from "node:vm";
import * as NodeFS from "node:fs";
import { expect, it } from "vite-plus/test";
import { json } from "../../../../packages/client-runtime/node_modules/effect/dist/unstable/rpc/RpcSerialization.js";
import { splitIntoRecords } from "../../../../packages/client-runtime/src/e2ee/frame.ts";
import { UploadAppendInput } from "../../../../packages/contracts/src/uploads.ts";
import * as Schema from "../../../../packages/client-runtime/node_modules/effect/dist/Schema.js";
import {
  chatUploadObservationScript,
  projectChatUploadObservation,
} from "./chat-upload-observer.ts";

const codec = json.makeUnsafe();
const encode = (value: unknown) => codec.encode(value) as string;
function fixture(script = chatUploadObservationScript) {
  let time = 0;
  const calls: unknown[] = [];
  class Original {
    readonly url: string;
    protocol = "bibcode.rpc.chunked.v1";
    binaryType = "blob";
    bufferedAmount = 13;
    handlers = new Map<string, (event: Record<string, unknown>) => void>();
    constructor(url: string) {
      this.url = url;
    }
    addEventListener(kind: string, callback: (event: Record<string, unknown>) => void) {
      this.handlers.set(kind, callback);
    }
    send(data: unknown) {
      calls.push(data);
      return 7;
    }
    close(code?: number, reason?: string) {
      calls.push([code, reason]);
      return 9;
    }
    emit(kind: string, event: Record<string, unknown> = {}) {
      this.handlers.get(kind)?.(event);
    }
  }
  const page = { WebSocket: Original } as unknown as {
    WebSocket: typeof Original;
    __uploadObservations: { read(): unknown };
  };
  NodeVM.runInNewContext(script, {
    window: page,
    URL,
    TextDecoder,
    TextEncoder,
    ArrayBuffer,
    Uint8Array,
    performance: { now: () => time },
  });
  const socket = new page.WebSocket("ws://localhost:4903/ws?ticket=do-not-retain");
  socket.emit("open");
  const read = () => projectChatUploadObservation(page.__uploadObservations.read())!;
  return {
    socket,
    calls,
    page,
    read,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
const append = (id: string | number, bytes = 3) => ({
  _tag: "Request",
  id,
  tag: "uploads.append",
  payload: {
    uploadId: "secret-upload-id",
    offset: 0,
    data: Buffer.alloc(bytes).toString("base64"),
  },
  headers: [],
});
const exit = (requestId: string | number, receivedBytes = 3) => ({
  _tag: "Exit",
  requestId,
  exit: { _tag: "Success", value: { receivedBytes } },
});
function deliver(socket: ReturnType<typeof fixture>["socket"], value: unknown, flag = 0) {
  const body = new TextEncoder().encode(encode(value));
  const record = new Uint8Array(body.length + 1);
  record[0] = flag;
  record.set(body, 1);
  socket.emit("message", { data: record.buffer });
}

it("accounts actual serializer appends and binary Exit per socket without changing socket behavior", () => {
  const f = fixture();
  expect(f.socket.binaryType).toBe("blob");
  const first = encode(append("secret-request"));
  expect(f.socket.send(first)).toBe(7);
  f.advance(12);
  deliver(f.socket, exit("secret-request"), 2);
  f.socket.send(encode(append(2)));
  deliver(f.socket, exit(2));
  expect(f.calls).toEqual([first, encode(append(2))]);
  expect(f.read().plain.append).toMatchObject({
    outstanding: 0,
    maximumOutstanding: 1,
    successes: 2,
    minRawBytes: 3,
    maxRawBytes: 3,
    minReplyMs: 0,
    maxReplyMs: 12,
  });
  expect(f.read().plain.complete).toBe(true);
  expect(JSON.stringify(f.read())).not.toMatch(/secret|ticket|data|headers|requestId/);
});

it("recognizes nested real config, arrays, and interleaved controls without losing partial data", () => {
  const f = fixture();
  f.socket.send(encode([append("a"), append("b")]));
  f.socket.send(
    encode({
      _tag: "Request",
      id: "config",
      tag: "subscribeServerConfig",
      payload: {},
      headers: [],
    }),
  );
  const value = {
    _tag: "Chunk",
    requestId: "config",
    values: [
      {
        version: 1,
        type: "snapshot",
        config: { environment: { capabilities: { attachmentStaging: true } } },
      },
    ],
  };
  const body = new TextEncoder().encode(encode(value));
  f.socket.emit("message", { data: Uint8Array.of(1, ...body.subarray(0, 10)).buffer });
  deliver(f.socket, { _tag: "Pong" }, 2);
  deliver(f.socket, exit("a"), 2);
  f.socket.emit("message", { data: Uint8Array.of(0, ...body.subarray(10)).buffer });
  f.socket.emit("message", { data: encode(exit("b")) });
  expect(f.read().plain).toMatchObject({
    capability: true,
    control: { pong: 1 },
    append: { maximumOutstanding: 2, outstanding: 0 },
    complete: true,
  });
});

it("calibrates outgoing budget with the actual largest legal encoded append", () => {
  const f = fixture();
  const payload = Schema.decodeSync(UploadAppendInput)({
    uploadId: "x".repeat(128),
    offset: 9 * 1024 ** 2,
    data: Buffer.alloc(1024 ** 2).toString("base64"),
    sha256: "f".repeat(64),
  });
  const request = encode({
    _tag: "Request",
    id: "x".repeat(128),
    tag: "uploads.append",
    payload,
    headers: [],
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    sampled: true,
  });
  f.socket.send(request);
  deliver(f.socket, exit("x".repeat(128), 10 * 1024 ** 2));
  expect(f.read().plain.append).toMatchObject({ maxRawBytes: 1024 ** 2, successes: 1 });
  expect(f.read().plain.complete).toBe(true);
});

it("uses production codec records as a bounded inbound oracle", () => {
  const f = fixture();
  const body = new TextEncoder().encode(
    encode({ _tag: "Chunk", requestId: "large", values: [{ padding: "x".repeat(90_000) }] }),
  );
  for (const record of splitIntoRecords(body)) f.socket.emit("message", { data: record });
  expect(f.read().plain.complete).toBe(true);
});

it.each(["unnegotiated", "blob", "noise"])(
  "does not guess binary or encrypted framing: %s",
  (kind) => {
    const f = fixture();
    if (kind === "noise") {
      const noise = new f.page.WebSocket("ws://localhost:4911/ws-e2ee");
      noise.emit("open");
      noise.send(encode(append("private")));
      noise.emit("message", { data: Uint8Array.of(2, 123).buffer });
      expect(f.read().noise).toMatchObject({
        created: 1,
        opened: 1,
        applicationMetricsAvailable: false,
      });
      expect(f.read().plain.requests.append).toBe(0);
    } else {
      if (kind === "unnegotiated") f.socket.protocol = "";
      f.socket.emit("message", {
        data:
          kind === "blob"
            ? {
                arrayBuffer: () => {
                  throw new Error("must not convert");
                },
              }
            : Uint8Array.of(0, 123).buffer,
      });
      expect(f.read().plain.complete).toBe(false);
      expect(f.read().plain.issues.unsupported).toBe(1);
    }
  },
);

it("discards oversized incoming data yet accounts independent controls and future messages", () => {
  const f = fixture();
  f.socket.send(encode(append("a")));
  const body = new TextEncoder().encode(
    encode({ _tag: "Chunk", requestId: "large", values: [{ padding: "x".repeat(300_000) }] }),
  );
  const records = splitIntoRecords(body);
  for (const record of records.slice(0, -1)) f.socket.emit("message", { data: record.buffer });
  deliver(f.socket, exit("a"), 2);
  deliver(f.socket, { _tag: "Pong" }, 2);
  f.socket.emit("message", { data: records.at(-1)!.buffer });
  expect(f.read().plain).toMatchObject({
    complete: false,
    partialMessages: 0,
    issues: { overflow: 1 },
    append: { outstanding: 0, successes: 1 },
    control: { pong: 1 },
  });
});

it.each([
  null,
  [],
  {},
  { _tag: 7 },
  { _tag: "Exit", requestId: "a", exit: null },
  { _tag: "Exit", requestId: "a", exit: { _tag: "Success", value: { receivedBytes: -1 } } },
])("marks malformed replies partial without retiring a live append: %j", (value) => {
  const f = fixture();
  f.socket.send(encode(append("a")));
  f.socket.emit("message", { data: encode(value) });
  expect(f.read().plain.complete).toBe(false);
  expect(f.read().plain.append.outstanding).toBe(1);
});

it("separates sockets, duplicates and abandonment from acknowledgements", () => {
  const f = fixture();
  f.socket.send(encode(append("same")));
  const second = new f.page.WebSocket("ws://localhost:4903/ws");
  second.emit("open");
  second.send(encode(append("same")));
  deliver(second, exit("same"));
  expect(f.read().plain.append.outstanding).toBe(1);
  f.socket.send(encode(append("same")));
  expect(f.read().plain.issues.unknown).toBe(1);
  f.socket.emit("message", { data: Uint8Array.of(1, 123).buffer });
  f.socket.emit("close");
  expect(f.read().plain).toMatchObject({
    complete: false,
    partialMessages: 0,
    append: { outstanding: 0, abandoned: 1, successes: 1 },
  });
});

it("accounts failures without keeping their cause and preserves close arguments/results", () => {
  const f = fixture();
  f.socket.send(encode(append("a")));
  deliver(f.socket, {
    _tag: "Exit",
    requestId: "a",
    exit: { _tag: "Failure", cause: [{ _tag: "Interrupt", reason: "private-secret" }] },
  });
  expect(f.socket.close(4408, "private-close-reason")).toBe(9);
  expect(f.calls.at(-1)).toEqual([4408, "private-close-reason"]);
  expect(f.read().plain).toMatchObject({
    append: { failures: 1, outstanding: 0 },
    lastCloseCode: 4408,
    maxBufferedBytesAtClose: 13,
  });
  expect(JSON.stringify(f.read())).not.toContain("private");
});

it("bounds pending identities and refuses to claim completeness after overflow", () => {
  const f = fixture();
  for (let index = 0; index < 65; index++) f.socket.send(encode(append(index)));
  expect(f.read().plain).toMatchObject({
    complete: false,
    issues: { overflow: 1 },
    append: { outstanding: 64 },
  });
  for (let index = 0; index < 18; index++)
    new f.page.WebSocket("ws://localhost:4903/ws").emit("open");
  expect(f.read().socketOverflow).toBe(true);
});

it("strict projection cannot retain foreign fields, raw identifiers, getters or inherited JSON hooks", () => {
  const f = fixture();
  const valid = f.read();
  expect(projectChatUploadObservation({ ...valid, raw: "private" })).toBeNull();
  expect(
    projectChatUploadObservation({ ...valid, plain: { ...valid.plain, cause: "private" } }),
  ).toBeNull();
  expect(
    projectChatUploadObservation({
      ...valid,
      noise: { ...valid.noise, applicationMetricsAvailable: true },
    }),
  ).toBeNull();
  expect(
    projectChatUploadObservation({
      ...valid,
      plain: { ...valid.plain, complete: true, issues: { ...valid.plain.issues, malformed: 1 } },
    }),
  ).toBeNull();
  const inherited = Object.assign(
    Object.create({ toJSON: () => ({ raw: "private-json-hook" }) }),
    valid,
  );
  expect(JSON.stringify(projectChatUploadObservation(inherited))).not.toContain("private");
  const accessor = { ...valid };
  Object.defineProperty(accessor, "plain", {
    get: () => {
      throw new Error("private-getter");
    },
    enumerable: true,
  });
  expect(() => projectChatUploadObservation(accessor)).not.toThrow();
  expect(projectChatUploadObservation(accessor)).toBeNull();
});

it("does not count unsuccessful underlying sends or closes", () => {
  const f = fixture();
  const original = Object.getPrototypeOf(Object.getPrototypeOf(f.socket));
  const send = original.send;
  original.send = () => {
    throw new Error("underlying-send");
  };
  // The installer captures the original method at construction.
  const socket = new f.page.WebSocket("ws://localhost:4903/ws");
  socket.emit("open");
  expect(() => socket.send(encode(append("a")))).toThrow("underlying-send");
  expect(f.read().plain.requests.append).toBe(0);
  original.send = send;
});

it("binds capability to the actual config stream and refuses invalid capability values", () => {
  const f = fixture();
  const snapshot = (requestId: string, capabilities: unknown) => ({
    _tag: "Chunk",
    requestId,
    values: [{ version: 1, type: "snapshot", config: { environment: { capabilities } } }],
  });
  deliver(f.socket, snapshot("not-config", { attachmentStaging: true }));
  expect(f.read().plain.capability).toBeNull();
  f.socket.send(
    encode({
      _tag: "Request",
      id: "config",
      tag: "subscribeServerConfig",
      payload: {},
      headers: [],
    }),
  );
  deliver(f.socket, snapshot("config", {}));
  expect(f.read().plain.capability).toBe(false);
  deliver(f.socket, snapshot("config", { attachmentStaging: "private-invalid" }));
  expect(f.read().plain.complete).toBe(false);
  expect(f.read().plain.capability).toBeNull();
});

it("distinguishes per-socket high-water from the aggregate of independent connections", () => {
  const f = fixture();
  f.socket.send(encode(append("a")));
  const second = new f.page.WebSocket("ws://localhost:4903/ws");
  second.emit("open");
  second.send(encode(append("a")));
  expect(f.read().plain.append).toMatchObject({
    maximumOutstanding: 2,
    maximumOutstandingPerSocket: 1,
  });
});

it("installs the measured decoder through the actual controller's pre-document script", () => {
  const source = NodeFS.readFileSync(
    new URL("../qualify-chat-uploads.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("const observationScript =");
  const end = source.indexOf("\n\nlet browser:", start);
  const script = NodeVM.runInNewContext(source.slice(start, end) + "\nobservationScript", {
    browserStartupObservationScript: "",
    chatUploadObservationScript,
  });
  const f = fixture(script);
  f.socket.send(encode(append("a")));
  deliver(f.socket, exit("a"));
  f.socket.send(encode(append("b")));
  deliver(f.socket, exit("b"));
  expect(f.read().plain.append.maximumOutstanding).toBe(1);
});

it.each(["constructor", "__proto__", "ordinary.method"])(
  "ignores unrelated actual RPC requests without prototype lookup: %s",
  (tag) => {
    const f = fixture();
    f.socket.send(
      encode({ _tag: "Request", id: "a", tag, payload: { data: "private" }, headers: [] }),
    );
    expect(f.read().plain.complete).toBe(true);
    expect(f.read().plain.requests.append).toBe(0);
  },
);

it.each([
  Uint8Array.of(),
  Uint8Array.of(3, 1),
  Uint8Array.of(1),
  Uint8Array.of(2),
  Uint8Array.of(2, 0xff),
])("makes malformed records incomplete and never guesses their content: %j", (data) => {
  const f = fixture();
  f.socket.emit("message", { data: data.buffer });
  expect(f.read().plain.complete).toBe(false);
  expect(f.read().plain.issues.malformed).toBe(1);
});

it("bounds record count and still processes controls while discarding", () => {
  const f = fixture();
  for (let index = 0; index < 2049; index++)
    f.socket.emit("message", { data: Uint8Array.of(1, 32).buffer });
  deliver(f.socket, { _tag: "Pong" }, 2);
  f.socket.emit("message", { data: Uint8Array.of(0, 32).buffer });
  expect(f.read().plain).toMatchObject({
    complete: false,
    partialMessages: 0,
    issues: { overflow: 1 },
    control: { pong: 1 },
  });
});

it("marks missing, oversized, invalid outgoing envelopes and IDs honestly", () => {
  const f = fixture();
  f.socket.send("x".repeat(2 * 1024 ** 2));
  f.socket.send(encode(append("x".repeat(129))));
  f.socket.send(encode({ ...append("invalid"), payload: { offset: 0, data: "!invalid-base64!" } }));
  expect(f.read().plain).toMatchObject({
    complete: false,
    requests: { append: 0 },
    issues: { malformed: 2, overflow: 1 },
  });
});

it("does not convert underlying close failure into an observed close call", () => {
  const f = fixture();
  const original = Object.getPrototypeOf(Object.getPrototypeOf(f.socket));
  original.close = () => {
    throw new Error("underlying-close");
  };
  const socket = new f.page.WebSocket("ws://localhost:4903/ws");
  socket.emit("open");
  expect(() => socket.close(4408, "private")).toThrow("underlying-close");
  expect(f.read().plain.closeCalls).toBe(0);
});

it("rejects contradictory or out-of-bounds projected counters", () => {
  const f = fixture();
  const valid = f.read();
  for (const offset of [-1, 10 * 1024 ** 2 + 1, "private", Infinity]) {
    expect(
      projectChatUploadObservation({
        ...valid,
        plain: { ...valid.plain, append: { ...valid.plain.append, maxAcknowledgedOffset: offset } },
      }),
    ).toBeNull();
  }
  expect(
    projectChatUploadObservation({ ...valid, plain: { ...valid.plain, opened: 2 } }),
  ).toBeNull();
  expect(
    projectChatUploadObservation({
      ...valid,
      plain: {
        ...valid.plain,
        append: { ...valid.plain.append, outstanding: 2, maximumOutstanding: 1 },
      },
    }),
  ).toBeNull();
  expect(
    projectChatUploadObservation({ ...valid, plain: { ...valid.plain, lastCloseCode: 3 } }),
  ).toBeNull();
});

it("never changes a successful native close result when passive metadata is unavailable", () => {
  const f = fixture();
  Object.defineProperty(f.socket, "bufferedAmount", {
    get: () => {
      throw new Error("private-metadata-failure");
    },
  });
  expect(() => f.socket.close(4408, "private")).not.toThrow();
  expect(f.read().plain.complete).toBe(false);
  expect(f.read().plain.issues.unknown).toBe(1);
});

it("samples queued browser bytes before the real close can change them", () => {
  const f = fixture();
  const original = Object.getPrototypeOf(Object.getPrototypeOf(f.socket));
  original.close = function (this: { bufferedAmount: number }) {
    this.bufferedAmount = 0;
    return 9;
  };
  const socket = new f.page.WebSocket("ws://localhost:4903/ws");
  socket.emit("open");
  socket.close(4408);
  expect(f.read().plain.maxBufferedBytesAtClose).toBe(13);
});

it("preserves native receiver checks instead of implicitly binding send or close", () => {
  const f = fixture();
  const original = Object.getPrototypeOf(Object.getPrototypeOf(f.socket));
  original.send = function (this: unknown) {
    if (!(this instanceof original.constructor)) throw new TypeError("Illegal invocation");
    return 7;
  };
  original.close = original.send;
  const socket = new f.page.WebSocket("ws://localhost:4903/ws");
  socket.emit("open");
  const send = socket.send,
    close = socket.close;
  expect(() => send(encode(append("a")))).toThrow("Illegal invocation");
  expect(() => close(4408)).toThrow("Illegal invocation");
  expect(f.read().plain.requests.append).toBe(0);
  expect(f.read().plain.closeCalls).toBe(0);
});

it("preserves a native missing-send-argument error without normalizing it to undefined", () => {
  const f = fixture();
  const original = Object.getPrototypeOf(Object.getPrototypeOf(f.socket));
  const missing = new TypeError("native required argument");
  const calls: unknown[][] = [];
  original.send = function (...args: unknown[]) {
    if (args.length < 1) throw missing;
    calls.push(args);
    return 7;
  };
  const socket = new f.page.WebSocket("ws://localhost:4903/ws");
  socket.emit("open");
  let caught: unknown;
  try {
    Reflect.apply(socket.send, socket, []);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(missing);
  expect(calls).toEqual([]);
  expect(f.read().plain.requests.append).toBe(0);
  expect(f.read().plain.issues.unsupported).toBe(0);
});

it.each([
  { args: [undefined] },
  { args: ["valid", "extra"] },
  { args: ["valid", undefined, { private: "extra-identity" }] },
])("forwards every actual send argument and return identity: %j", ({ args }) => {
  const f = fixture();
  const original = Object.getPrototypeOf(Object.getPrototypeOf(f.socket));
  const nativeResult = {};
  const captured: Array<{ receiver: unknown; forwarded: unknown[] }> = [];
  original.send = function (this: unknown, ...values: unknown[]) {
    captured.push({ receiver: this, forwarded: values });
    return nativeResult;
  };
  const socket = new f.page.WebSocket("ws://localhost:4903/ws");
  socket.emit("open");
  const values = [args[0] === "valid" ? encode(append("a")) : args[0], ...args.slice(1)];
  expect(Reflect.apply(socket.send, socket, values)).toBe(nativeResult);
  expect(captured).toHaveLength(1);
  expect(captured[0]!.receiver).toBe(socket);
  expect(captured[0]!.forwarded).toHaveLength(values.length);
  for (let index = 0; index < values.length; index++)
    expect(captured[0]!.forwarded[index]).toBe(values[index]);
  expect(f.read().plain.requests.append).toBe(typeof values[0] === "string" ? 1 : 0);
  expect(JSON.stringify(f.read())).not.toContain("extra-identity");
});

it.each([
  { args: [] },
  { args: [undefined] },
  { args: [4408] },
  { args: [4408, undefined] },
  { args: [4408, "private-reason", { private: "extra-identity" }] },
])("forwards complete close arguments including omission: %j", ({ args }) => {
  const f = fixture();
  const original = Object.getPrototypeOf(Object.getPrototypeOf(f.socket));
  const nativeResult = {};
  const captured: Array<{ receiver: unknown; forwarded: unknown[] }> = [];
  original.close = function (this: { bufferedAmount: number }, ...values: unknown[]) {
    captured.push({ receiver: this, forwarded: values });
    this.bufferedAmount = 0;
    return nativeResult;
  };
  const socket = new f.page.WebSocket("ws://localhost:4903/ws");
  socket.emit("open");
  expect(Reflect.apply(socket.close, socket, args)).toBe(nativeResult);
  expect(captured).toHaveLength(1);
  expect(captured[0]!.receiver).toBe(socket);
  expect(captured[0]!.forwarded).toHaveLength(args.length);
  for (let index = 0; index < args.length; index++)
    expect(captured[0]!.forwarded[index]).toBe(args[index]);
  expect(f.read().plain.closeCalls).toBe(1);
  expect(f.read().plain.maxBufferedBytesAtClose).toBe(13);
  expect(JSON.stringify(f.read())).not.toMatch(/private-reason|extra-identity/);
});
