import { ProjectDownloadEvent } from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { openEncryptedTestSocket, streamTestRpc, type EncryptedTestSocket } from "./testSupport.ts";

const values = [
  {
    _tag: "start",
    kind: "file",
    fileName: "a",
    sizeBytes: 1,
    version: { sizeBytes: 1, modifiedAtNs: "1" },
  },
  { _tag: "bytes", offset: 0, data: "YQ==" },
  { _tag: "end", totalBytes: 1 },
];
const success = { _tag: "Exit", requestId: "read", exit: { _tag: "Success", value: null } };
const decode = Schema.decodeUnknownSync(ProjectDownloadEvent);
function channel(messages: unknown[]) {
  const sent: unknown[] = [];
  const socket: EncryptedTestSocket = {
    nextMessage: () => {
      const next = messages.shift();
      return next === undefined
        ? Promise.reject(new Error("fixture stream closed"))
        : Promise.resolve(JSON.stringify(next));
    },
    sendMessage: (value) => {
      sent.push(JSON.parse(value));
    },
    sendRecords: () => {
      throw new Error("Unexpected raw send");
    },
    close: () => {},
  };
  return { socket, sent };
}

describe("finite encrypted test RPC", () => {
  it("bounds socket opening and closes its owned socket when readiness never arrives", async () => {
    vi.useFakeTimers();
    const sockets: Array<EventTarget & { closed: boolean; close(): void }> = [];
    class NeverOpenSocket extends EventTarget {
      closed = false;
      constructor() {
        super();
        sockets.push(this);
      }
      close() {
        this.closed = true;
        this.dispatchEvent(new Event("close"));
      }
    }
    vi.stubGlobal("WebSocket", NeverOpenSocket);
    let rejected = false;
    const opening = openEncryptedTestSocket(
      "http://127.0.0.1:14989",
      new Uint8Array(32).fill(7),
    ).catch(() => {
      rejected = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(10_001);
      expect(rejected).toBe(true);
      expect(sockets[0]!.closed).toBe(true);
    } finally {
      sockets[0]!.dispatchEvent(new Event("error"));
      await opening;
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("closes its socket when the Noise handshake fails", async () => {
    const sockets: Array<EventTarget & { closed: boolean }> = [];
    class BadHandshakeSocket extends EventTarget {
      closed = false;
      constructor() {
        super();
        sockets.push(this);
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      send() {
        this.dispatchEvent(new MessageEvent("message", { data: new Uint8Array([1]).buffer }));
      }
      close() {
        this.closed = true;
        this.dispatchEvent(new Event("close"));
      }
    }
    vi.stubGlobal("WebSocket", BadHandshakeSocket);
    try {
      await expect(
        openEncryptedTestSocket("http://127.0.0.1:14989", new Uint8Array(32).fill(7)),
      ).rejects.toThrow();
      expect(sockets[0]!.closed).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("acknowledges one packed start/bytes/end chunk and waits for successful Exit", async () => {
    const h = channel([{ _tag: "Chunk", requestId: "read", values }, success]);
    expect(
      await streamTestRpc(
        h.socket,
        "read",
        "projects.readDownload",
        { cwd: "/fixture", relativePath: "a" },
        decode,
      ),
    ).toEqual(values);
    expect(h.sent).toEqual([
      {
        _tag: "Request",
        id: "read",
        tag: "projects.readDownload",
        payload: { cwd: "/fixture", relativePath: "a" },
        headers: [],
      },
      { _tag: "Ack", requestId: "read" },
    ]);
  });

  it("acks every matching chunk, including end, without confusing other responses", async () => {
    const h = channel([
      { _tag: "Pong" },
      { _tag: "Chunk", requestId: "other", values: [{}] },
      ...values.map((value) => ({ _tag: "Chunk", requestId: "read", values: [value] })),
      success,
    ]);
    expect(await streamTestRpc(h.socket, "read", "projects.readDownload", {}, decode)).toEqual(
      values,
    );
    expect(h.sent.slice(1)).toEqual(
      Array.from({ length: 3 }, () => ({ _tag: "Ack", requestId: "read" })),
    );
  });

  it("rejects a failing Exit even after a valid end", async () => {
    const h = channel([
      { _tag: "Chunk", requestId: "read", values },
      { _tag: "Exit", requestId: "read", exit: { _tag: "Failure", cause: [] } },
    ]);
    await expect(
      streamTestRpc(h.socket, "read", "projects.readDownload", {}, decode),
    ).rejects.toThrow("failed");
    expect(h.sent.slice(1)).toEqual([{ _tag: "Ack", requestId: "read" }]);
  });

  it("interrupts the stream when value decoding fails", async () => {
    const h = channel([{ _tag: "Chunk", requestId: "read", values: [{ _tag: "bad-value" }] }]);
    await expect(
      streamTestRpc(h.socket, "read", "projects.readDownload", {}, decode),
    ).rejects.toThrow();
    expect(h.sent.at(-1)).toEqual({ _tag: "Interrupt", requestId: "read" });
  });

  it("interrupts a stream that closes without its terminal Exit", async () => {
    const h = channel([{ _tag: "Chunk", requestId: "read", values }]);
    await expect(
      streamTestRpc(h.socket, "read", "projects.readDownload", {}, decode),
    ).rejects.toThrow("closed");
    expect(h.sent.slice(1)).toEqual([
      { _tag: "Ack", requestId: "read" },
      { _tag: "Interrupt", requestId: "read" },
    ]);
  });
});
