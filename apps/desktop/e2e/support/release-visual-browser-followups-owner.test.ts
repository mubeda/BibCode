// @effect-diagnostics nodeBuiltinImport:off - Inert actual Socket/event ports exercise the complete QA network caller.
import * as NodeNet from "node:net";
import * as NodeModule from "node:module";
import {
  plaintextRecords,
  E2EE_RECORD_FLAG_CONTROL,
} from "../../../../packages/client-runtime/src/e2ee/frame.ts";
import { createBrowserFollowupProtocolObserver } from "./release-visual-browser-followups-protocol.ts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import {
  withBrowserFollowupSecondWindow,
  withBrowserFollowupResource,
  withBrowserFollowupWindow,
  withBrowserFollowupHostedEntry,
} from "./release-visual-browser-followups-owner.ts";
import {
  startBrowserFollowupTransport,
  startBrowserFollowupNetwork,
} from "./release-visual-browser-followups-network.ts";
import type { QualificationBrowser } from "./qualification-owner.ts";
const netPorts = vi.hoisted(() => ({
  servers: [] as Array<{
    port: number;
    calls: number;
    accept: (client: NodeNet.Socket) => void;
    callback: ((error?: Error | null) => void) | null;
  }>,
  connections: [] as NodeNet.Socket[],
  failures: new Map<number, Error>(),
  throws: new Set<number>(),
  pending: new Set<number>(),
}));
vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    createServer: (accept: (client: NodeNet.Socket) => void) => {
      const index = netPorts.servers.length,
        record = {
          port: 0,
          calls: 0,
          accept,
          callback: null as ((error?: Error | null) => void) | null,
        };
      netPorts.servers.push(record);
      return {
        once: () => {},
        removeListener: () => {},
        listen: (port: number, _host: string, callback: () => void) => {
          record.port = port;
          callback();
        },
        address: () => ({ port: record.port }),
        close: (callback: (error?: Error | null) => void) => {
          record.calls++;
          record.callback = callback;
          if (netPorts.throws.has(index)) throw netPorts.failures.get(index);
          if (!netPorts.pending.has(index)) callback(netPorts.failures.get(index));
        },
      };
    },
    connect: () => {
      const socket = netPorts.connections.shift();
      if (!socket) throw new Error("Unexpected inert socket connection");
      return socket;
    },
  };
});
beforeEach(() => {
  netPorts.servers.length = 0;
  netPorts.connections.length = 0;
  netPorts.failures.clear();
  netPorts.throws.clear();
  netPorts.pending.clear();
});
it("retains the same failed transport close promise and joins observer teardown despite server refusal", async () => {
  const original = new Error("Inert server close refusal");
  netPorts.failures.set(0, original);
  let observerClosed = 0;
  const transport = await startBrowserFollowupTransport({
    CI: "true",
    listenPort: 4894,
    targetPort: 4897,
    observer: {
      close: () => {
        observerClosed++;
      },
    } as never,
  });
  const first = transport.close(),
    second = transport.close();
  await expect(first).rejects.toBe(original);
  await expect(second).rejects.toBe(original);
  expect(second).toBe(first);
  expect(netPorts.servers[0]!.calls).toBe(1);
  expect(observerClosed).toBe(1);
  expect(transport.observation()).toMatchObject({
    closed: true,
    failed: true,
    cleanupComplete: false,
    cleanupFailed: true,
  });
});
it("joins one pending transport teardown before declaring cleanup complete", async () => {
  netPorts.pending.add(0);
  let observerClosed = 0;
  const transport = await startBrowserFollowupTransport({
    CI: "true",
    listenPort: 4894,
    targetPort: 4897,
    observer: {
      close: () => {
        observerClosed++;
      },
    } as never,
  });
  const first = transport.close(),
    second = transport.close();
  expect(transport.observation()).toMatchObject({
    closed: true,
    cleanupComplete: false,
    cleanupFailed: false,
  });
  expect(second).toBe(first);
  expect(netPorts.servers[0]!.calls).toBe(1);
  expect(observerClosed).toBe(0);
  netPorts.servers[0]!.callback!(null);
  await first;
  await second;
  expect(observerClosed).toBe(1);
  expect(transport.observation()).toMatchObject({ cleanupComplete: true, cleanupFailed: false });
});
it("keeps the first server failure when observer teardown also refuses and never reports a completed cleanup", async () => {
  const original = new Error("Inert first close refusal"),
    later = new Error("Inert observer refusal");
  netPorts.failures.set(0, original);
  let observerAttempts = 0;
  const transport = await startBrowserFollowupTransport({
    CI: "true",
    listenPort: 4894,
    targetPort: 4897,
    observer: {
      close: () => {
        observerAttempts++;
        throw later;
      },
    } as never,
  });
  await expect(transport.close()).rejects.toBe(original);
  await expect(transport.close()).rejects.toBe(original);
  expect(observerAttempts).toBe(1);
  expect(transport.observation()).toMatchObject({
    cleanupComplete: false,
    cleanupFailed: true,
    failed: true,
  });
});
it("preserves the original outer network cleanup failure and reports unsafe once across repeated close calls", async () => {
  const original = new Error("Inert public proxy refusal");
  netPorts.failures.set(1, original);
  netPorts.throws.add(1);
  let unsafe = 0;
  const network = await startBrowserFollowupNetwork({
    CI: "true",
    listenPort: 4887,
    targetPort: 4897,
    png: Buffer.alloc(0),
    cwd: "/owned",
    threadId: "owned-thread",
    terminalId: "term-1",
    patch: () => "",
    observeUnsafeCleanup: () => {
      unsafe++;
    },
  });
  const first = network.close(),
    second = network.close();
  await expect(first).rejects.toBe(original);
  await expect(second).rejects.toBe(original);
  expect(second).toBe(first);
  expect(unsafe).toBe(1);
  expect(netPorts.servers.map((value) => value.calls)).toEqual([1, 1]);
});
it("revokes the owned unsubmitted hosted grant even when build admission fails", async () => {
  const original = new Error("Inert hosted source failure");
  let revoked = 0;
  await expect(
    withBrowserFollowupHostedEntry(
      {
        mode: "confirm",
        theme: "dark",
        browser: {} as QualificationBrowser,
        owner: { until: async () => {} },
        token: "owned-unused-token",
        verifyHostedBuild: async () => {
          throw original;
        },
        verifyOwnedUnsubmittedLink: async () => {},
        revokeOwnedUnsubmittedLink: async () => {
          revoked++;
        },
        observeUnsafeCleanup: () => {},
      },
      async () => {},
    ),
  ).rejects.toBe(original);
  expect(revoked).toBe(1);
});
it("retains the original failure while joining and reporting unsafe cleanup", async () => {
  const original = new Error("Inert original failure");
  let cleanup = 0,
    unsafe = 0;
  await expect(
    withBrowserFollowupResource({
      run: async () => {
        throw original;
      },
      cleanup: async () => {
        cleanup++;
        throw new Error("Inert cleanup failure");
      },
      observeUnsafeCleanup: () => unsafe++,
    }),
  ).rejects.toBe(original);
  expect(cleanup).toBe(1);
  expect(unsafe).toBe(1);
});
it("closes only the newly owned window after capture failure and restores the original handle", async () => {
  const handles = ["original"];
  let current = "original";
  const closed: string[] = [];
  const browser = {
    getWindowHandles: async () => [...handles],
    getWindowHandle: async () => current,
    newWindow: async () => {
      handles.push("created");
      current = "created";
      return { handle: "created" };
    },
    switchToWindow: async (handle: string) => {
      current = handle;
    },
    closeWindow: async () => {
      closed.push(current);
      handles.splice(handles.indexOf(current), 1);
    },
  } as unknown as QualificationBrowser;
  const original = new Error("Inert capture failure");
  await expect(
    withBrowserFollowupWindow(
      {
        browser,
        entry: "http://127.0.0.1:4885/local/owned-thread",
        observeUnsafeCleanup: () => {},
      },
      async () => {
        throw original;
      },
    ),
  ).rejects.toBe(original);
  expect(closed).toEqual(["created"]);
  expect(handles).toEqual(["original"]);
  expect(current).toBe("original");
});
it("refuses the real network adapter outside CI before opening any socket", async () => {
  await expect(
    startBrowserFollowupNetwork({
      CI: undefined,
      listenPort: 4887,
      targetPort: 4897,
      png: Buffer.alloc(0),
      cwd: "/owned",
      threadId: "owned-thread",
      terminalId: "term-1",
      patch: () => "",
      observeUnsafeCleanup: () => {},
    }),
  ).rejects.toThrow();
  await expect(
    startBrowserFollowupTransport({
      CI: undefined,
      listenPort: 4894,
      targetPort: 4887,
      observer: {} as never,
    }),
  ).rejects.toThrow();
});

const rpcJson: { encode: (value: unknown) => string } = NodeModule.createRequire(
  new URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/unstable/rpc/RpcSerialization").json.makeUnsafe();
function socketPort() {
  const socket = new NodeNet.Socket(),
    writes: Buffer[] = [];
  vi.spyOn(socket, "write").mockImplementation((bytes) => {
    if (!Buffer.isBuffer(bytes)) throw new Error("Inert wire byte contract refused");
    writes.push(Buffer.from(bytes));
    return true;
  });
  return { socket, writes };
}
function rpcWire(value: unknown, binary: boolean, masked: boolean): Buffer[] {
  const body = Buffer.from(rpcJson.encode(value));
  return (binary ? [...plaintextRecords(body)] : [body]).map((record) => {
    const header = Buffer.alloc(record.length < 126 ? 2 : record.length < 65536 ? 4 : 10);
    header[0] = binary ? 0x82 : 0x81;
    header[1] =
      (masked ? 128 : 0) |
      (record.length < 126 ? record.length : record.length < 65536 ? 126 : 127);
    if (header.length === 4) header.writeUInt16BE(record.length, 2);
    if (header.length === 10) header.writeBigUInt64BE(BigInt(record.length), 2);
    const payload = Buffer.from(record),
      mask = Buffer.from([7, 11, 19, 23]);
    if (masked) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
    return Buffer.concat(masked ? [header, mask, payload] : [header, payload]);
  });
}
function admitSocket(offer: string | null, selected: string | null) {
  const client = socketPort(),
    upstream = socketPort();
  netPorts.connections.push(upstream.socket);
  netPorts.servers[0]!.accept(client.socket);
  const requestHeader = Buffer.from(
    "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: owned=inert\r\nAuthorization: Bearer inert\r\n" +
      (offer === null ? "" : "Sec-WebSocket-Protocol: " + offer + "\r\n") +
      "\r\n",
  );
  client.socket.emit("data", requestHeader.subarray(0, 17));
  client.socket.emit("data", requestHeader.subarray(17));
  const replyHeader = Buffer.from(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      (selected === null ? "" : "Sec-WebSocket-Protocol: " + selected + "\r\n") +
      "\r\n",
  );
  upstream.socket.emit("data", replyHeader.subarray(0, 5));
  upstream.socket.emit("data", replyHeader.subarray(5));
  return { client, upstream, requestHeader, replyHeader };
}
function actualReplayObserver() {
  return createBrowserFollowupProtocolObserver({
    png: Buffer.alloc(0),
    cwd: "/owned/project",
    threadId: "owned-thread",
    terminalId: "term-1",
    patch: () => "",
    slowTransport: () => false,
  });
}
it.each(["chunked", "bare", "not-selected"])(
  "runs the complete %s upgrade with untouched authentication/header/text bytes",
  async (mode) => {
    const observer = actualReplayObserver();
    const transport = await startBrowserFollowupTransport({
      CI: "true",
      listenPort: 4894,
      targetPort: 4897,
      observer,
    });
    try {
      const wire = admitSocket(
        mode === "bare" ? null : "future.v1, bibcode.rpc.chunked.v1",
        mode === "chunked" ? "bibcode.rpc.chunked.v1" : null,
      );
      expect(Buffer.concat(wire.upstream.writes)).toEqual(wire.requestHeader);
      expect(Buffer.concat(wire.client.writes)).toEqual(wire.replyHeader);
      const bytes = rpcWire(
        { _tag: "Request", id: "1", tag: "subscribeServerConfig", payload: {}, headers: [] },
        mode === "chunked",
        true,
      );
      for (const record of bytes) {
        wire.client.socket.emit("data", record.subarray(0, 3));
        wire.client.socket.emit("data", record.subarray(3));
      }
      expect(Buffer.concat(wire.upstream.writes)).toEqual(
        Buffer.concat([wire.requestHeader, ...bytes]),
      );
      expect(observer.rendererConnection("connection-1")).toBe(true);
      expect(transport.observation()).toMatchObject({ failed: false, upgradedConnections: 1 });
    } finally {
      await transport.close();
    }
    expect(transport.observation()).toMatchObject({ cleanupComplete: true, cleanupFailed: false });
  },
);
it.each(["unsolicited", "unsupported", "duplicate-selection", "bad-offer"])(
  "refuses complete-caller %s negotiation before observing RPC",
  async (mode) => {
    const observer = actualReplayObserver(),
      transport = await startBrowserFollowupTransport({
        CI: "true",
        listenPort: 4894,
        targetPort: 4897,
        observer,
      });
    try {
      const wire = admitSocket(
        mode === "unsolicited"
          ? null
          : mode === "bad-offer"
            ? "bad protocol"
            : "bibcode.rpc.chunked.v1",
        mode === "unsupported"
          ? "foreign.v1"
          : mode === "duplicate-selection"
            ? "bibcode.rpc.chunked.v1, bibcode.rpc.chunked.v1"
            : "bibcode.rpc.chunked.v1",
      );
      expect(transport.observation().failed).toBe(true);
      expect(wire.client.writes).toEqual([]);
      expect(observer.rendererConnection("connection-1")).toBe(false);
      expect(wire.client.socket.destroyed).toBe(true);
      expect(wire.upstream.socket.destroyed).toBe(true);
    } finally {
      await transport.close();
    }
  },
);
it.each(["owned", "foreign-pid", "foreign-cwd", "foreign-claim"])(
  "joins maintained large terminal records to the existing %s replay owner",
  async (mode) => {
    const observer = actualReplayObserver(),
      transport = await startBrowserFollowupTransport({
        CI: "true",
        listenPort: 4894,
        targetPort: 4897,
        observer,
      });
    const history = "Owned shared terminal output\r\n" + "\n".repeat(65400);
    const ownedWires: ReturnType<typeof admitSocket>[] = [];
    try {
      for (const [index, claim] of [
        [0, "first-owner"],
        [1, "second-owner"],
      ] as const) {
        const wire = admitSocket("bibcode.rpc.chunked.v1", "bibcode.rpc.chunked.v1");
        ownedWires.push(wire);
        const subscribe = {
          _tag: "Request",
          id: "1",
          tag: "subscribeServerConfig",
          payload: {},
          headers: [],
        };
        const attach = {
          _tag: "Request",
          id: "2",
          tag: "terminal.attach",
          payload: {
            threadId: "owned-thread",
            terminalId: "term-1",
            cwd: "/owned/project",
            sizeClaim: claim,
          },
          headers: [],
        };
        for (const request of [subscribe, attach])
          for (const record of rpcWire(request, false, true))
            wire.client.socket.emit("data", record);
        const snapshot = {
          threadId: "owned-thread",
          terminalId: "term-1",
          cwd: index === 1 && mode === "foreign-cwd" ? "/foreign" : "/owned/project",
          worktreePath: null,
          status: "running",
          pid: index === 1 && mode === "foreign-pid" ? 124 : 123,
          history,
          exitCode: null,
          exitSignal: null,
          label: "Terminal 1",
          updatedAt: "2026-10-06T10:00:00.000Z",
          size: { cols: 91, rows: 24, sizeClaim: "first-owner" },
        };
        const event = { _tag: "Chunk", requestId: "2", values: [{ type: "snapshot", snapshot }] };
        const records = rpcWire(event, true, false);
        expect(records.length).toBeGreaterThan(2);
        for (const record of records) {
          wire.upstream.socket.emit("data", record.subarray(0, 5));
          wire.upstream.socket.emit("data", record.subarray(5));
        }
        expect(Buffer.concat(wire.client.writes)).toEqual(
          Buffer.concat([
            wire.replyHeader,
            ...(index === 1 && mode === "foreign-cwd" ? records.slice(0, -1) : records),
          ]),
        );
      }
      if (mode === "owned" || mode === "foreign-claim")
        expect(() => observer.terminal()).not.toThrow();
      else expect(() => observer.terminal()).toThrow();
      const resize = {
        _tag: "Chunk",
        requestId: "2",
        values: [
          {
            type: "resized",
            threadId: "owned-thread",
            terminalId: "term-1",
            size: {
              cols: 91,
              rows: 30,
              sizeClaim: mode === "foreign-claim" ? "foreign-owner" : "second-owner",
            },
          },
        ],
      };
      for (const wire of ownedWires)
        for (const record of rpcWire(resize, true, false))
          wire.upstream.socket.emit("data", record);
      if (mode === "owned") {
        expect(() => observer.fitted()).not.toThrow();
        expect(transport.observation().failed).toBe(false);
      } else expect(() => observer.fitted()).toThrow();
    } finally {
      await transport.close();
    }
    expect(transport.observation()).toMatchObject({ cleanupComplete: true, cleanupFailed: false });
  },
);

it("holds and releases the complete selected original network sequence once beyond the unchanged threshold", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(100);
  const observer = actualReplayObserver(),
    transport = await startBrowserFollowupTransport({
      CI: "true",
      listenPort: 4894,
      targetPort: 4897,
      observer,
    });
  try {
    const wire = admitSocket("bibcode.rpc.chunked.v1", "bibcode.rpc.chunked.v1");
    const subscribe = rpcWire(
      { _tag: "Request", id: "1", tag: "subscribeServerConfig", payload: {}, headers: [] },
      false,
      true,
    );
    for (const record of subscribe) wire.client.socket.emit("data", record);
    transport.arm();
    const request = rpcWire(
      { _tag: "Request", id: "3", tag: "server.getTraceDiagnostics", payload: {}, headers: [] },
      true,
      true,
    );
    for (const record of request) wire.client.socket.emit("data", record);
    const selected = rpcWire(
      {
        _tag: "Exit",
        requestId: "3",
        exit: { _tag: "Success", value: { content: "x".repeat(140000) } },
      },
      true,
      false,
    );
    wire.upstream.socket.emit("data", selected[0]!);
    const pong = rpcWire({ _tag: "Pong" }, true, false)[0]!;
    pong[2] = E2EE_RECORD_FLAG_CONTROL;
    const ping = Buffer.concat([Buffer.from([0x89, 5]), Buffer.from("owned")]);
    wire.upstream.socket.emit("data", Buffer.concat([pong, ping]));
    for (const record of selected.slice(1)) {
      wire.upstream.socket.emit("data", record.subarray(0, 3));
      wire.upstream.socket.emit("data", record.subarray(3));
    }
    expect(wire.client.writes).toEqual([wire.replyHeader, pong, ping]);
    expect(Buffer.concat(wire.upstream.writes)).toEqual(
      Buffer.concat([wire.requestHeader, ...subscribe, ...request]),
    );
    expect(transport.observation().heldReplies).toBe(1);
    vi.setSystemTime(15100);
    expect(() => transport.verifyHeld()).toThrow();
    expect(() => transport.release()).toThrow();
    vi.setSystemTime(15101);
    expect(transport.verifyHeld().elapsedBeyondThreshold).toBe(true);
    transport.release();
    expect(wire.client.writes).toEqual([wire.replyHeader, pong, ping, ...selected]);
    expect(() => transport.release()).toThrow();
  } finally {
    await transport.close();
    vi.useRealTimers();
  }
  expect(transport.observation()).toMatchObject({
    cleanupComplete: true,
    cleanupFailed: false,
    failed: false,
  });
});
it("keeps ordinary HTTP headers and binary body chunks unchanged without attempting RPC negotiation", async () => {
  const observer = actualReplayObserver(),
    transport = await startBrowserFollowupTransport({
      CI: "true",
      listenPort: 4894,
      targetPort: 4897,
      observer,
    });
  try {
    const client = socketPort(),
      upstream = socketPort();
    netPorts.connections.push(upstream.socket);
    netPorts.servers[0]!.accept(client.socket);
    const body = Buffer.from([0, 255, 37, 128, 3]),
      request = Buffer.concat([
        Buffer.from(
          "POST /owned HTTP/1.1\r\nCookie: owned=inert\r\nAuthorization: Bearer inert\r\nContent-Length: 5\r\n\r\n",
        ),
        body,
      ]);
    client.socket.emit("data", request.subarray(0, 9));
    client.socket.emit("data", request.subarray(9));
    expect(Buffer.concat(upstream.writes)).toEqual(request);
    const reply = Buffer.concat([
      Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n"),
      body,
    ]);
    upstream.socket.emit("data", reply.subarray(0, 7));
    upstream.socket.emit("data", reply.subarray(7));
    expect(Buffer.concat(client.writes)).toEqual(reply);
    expect(transport.observation()).toMatchObject({ failed: false, upgradedConnections: 0 });
  } finally {
    await transport.close();
  }
});

it.each(["offer", "selection"])(
  "refuses a high-bit %s byte instead of stripping it into the maintained protocol",
  async (side) => {
    const observer = actualReplayObserver(),
      transport = await startBrowserFollowupTransport({
        CI: "true",
        listenPort: 4894,
        targetPort: 4897,
        observer,
      });
    try {
      const client = socketPort(),
        upstream = socketPort();
      netPorts.connections.push(upstream.socket);
      netPorts.servers[0]!.accept(client.socket);
      const requestHeader = Buffer.from(
        "GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: bibcode.rpc.chunked.v1\r\n\r\n",
      );
      const replyHeader = Buffer.from(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: bibcode.rpc.chunked.v1\r\n\r\n",
      );
      const target = side === "offer" ? requestHeader : replyHeader;
      target[target.indexOf("bibcode.rpc.chunked.v1")] = 0xe2;
      client.socket.emit("data", requestHeader);
      upstream.socket.emit("data", replyHeader);
      expect(transport.observation().failed).toBe(true);
      expect(observer.rendererConnection("connection-1")).toBe(false);
    } finally {
      await transport.close();
    }
  },
);

it.each([
  ["offer", "leading", 0xa0],
  ["offer", "trailing", 0xa0],
  ["selection", "leading", 0xa0],
  ["selection", "trailing", 0xa0],
  ["offer", "leading", 0x85],
  ["offer", "trailing", 0x85],
  ["selection", "leading", 0x85],
  ["selection", "trailing", 0x85],
] satisfies Array<[string, string, number]>)(
  "refuses %s %s high-bit whitespace byte %i without changing upgrade bytes",
  async (side, edge, byte) => {
    const observer = actualReplayObserver(),
      transport = await startBrowserFollowupTransport({
        CI: "true",
        listenPort: 4894,
        targetPort: 4897,
        observer,
      });
    try {
      const client = socketPort(),
        upstream = socketPort();
      netPorts.connections.push(upstream.socket);
      netPorts.servers[0]!.accept(client.socket);
      let requestHeader = Buffer.from(
        "GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: bibcode.rpc.chunked.v1\r\n\r\n",
      );
      let replyHeader = Buffer.from(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: bibcode.rpc.chunked.v1\r\n\r\n",
      );
      const target = side === "offer" ? requestHeader : replyHeader;
      const start = target.indexOf("bibcode.rpc.chunked.v1");
      const at = edge === "leading" ? start : start + "bibcode.rpc.chunked.v1".length;
      const invalid = Buffer.concat([
        target.subarray(0, at),
        Buffer.from([byte]),
        target.subarray(at),
      ]);
      if (side === "offer") requestHeader = invalid;
      else replyHeader = invalid;
      client.socket.emit("data", requestHeader);
      upstream.socket.emit("data", replyHeader);
      expect(transport.observation().failed).toBe(true);
      expect(observer.rendererConnection("connection-1")).toBe(false);
      expect(client.writes).toEqual([]);
    } finally {
      await transport.close();
    }
  },
);
it("admits HTTP SP and HTAB around exactly selected protocol while forwarding their original bytes", async () => {
  const observer = actualReplayObserver(),
    transport = await startBrowserFollowupTransport({
      CI: "true",
      listenPort: 4894,
      targetPort: 4897,
      observer,
    });
  try {
    const wire = admitSocket(" \t bibcode.rpc.chunked.v1\t ", "\t bibcode.rpc.chunked.v1 \t");
    expect(Buffer.concat(wire.upstream.writes)).toEqual(wire.requestHeader);
    expect(Buffer.concat(wire.client.writes)).toEqual(wire.replyHeader);
    const request = rpcWire(
      { _tag: "Request", id: "1", tag: "subscribeServerConfig", payload: {}, headers: [] },
      true,
      true,
    );
    for (const record of request) wire.client.socket.emit("data", record);
    expect(observer.rendererConnection("connection-1")).toBe(true);
    expect(transport.observation().failed).toBe(false);
  } finally {
    await transport.close();
  }
});

it.each(["observer", "socket", "undefined"])(
  "actual transport preserves its first owned failure through retirement and close: %s",
  async (mode) => {
    const original =
      mode === "undefined" ? undefined : Object.freeze(new Error("inert original wire failure"));
    const observer = actualReplayObserver();
    if (mode === "observer")
      observer.observe = () => {
        throw original;
      };
    const transport = await startBrowserFollowupTransport({
      CI: "true",
      listenPort: 4894,
      targetPort: 4897,
      observer,
    });
    const pair = admitSocket(null, null);
    if (mode === "observer")
      for (const bytes of rpcWire(
        { _tag: "Request", id: "1", tag: "subscribeServerConfig", payload: {} },
        false,
        true,
      ))
        pair.client.socket.emit("data", bytes);
    else pair.upstream.socket.emit("error", original);
    expect(transport.observation().failed).toBe(true);
    expect(() => transport.throwIfFailed()).toThrow();
    let caught;
    try {
      transport.throwIfFailed();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(original);
    await transport.close();
    expect(transport.observation()).toMatchObject({ cleanupComplete: true, cleanupFailed: false });
    try {
      transport.throwIfFailed();
    } catch (error) {
      expect(error).toBe(original);
    }
  },
);

it.each(["owned", "setup-undefined", "restore-error"])(
  "second window joins named public ownership callbacks after restoration: %s",
  async (mode) => {
    const events: string[] = [];
    let handle = "main",
      handles = ["main"],
      unsafe = 0;
    const original = Object.freeze(new Error("Inert restoration failure."));
    const browser = {
      getWindowSize: async () => ({ width: 1280, height: 960 }),
      setWindowSize: async (_width: number, height: number) => {
        events.push("size:" + height);
      },
      getWindowHandles: async () => [...handles],
      getWindowHandle: async () => handle,
      newWindow: async () => {
        handles.push("second");
        handle = "second";
        events.push("open");
        return { handle: "second" };
      },
      switchToWindow: async (value: string) => {
        handle = value;
        events.push("switch:" + value);
      },
      closeWindow: async () => {
        handles = ["main"];
        events.push("close");
      },
      $: () => ({ isDisplayed: async () => false }),
    };
    let failed = false,
      caught: unknown;
    try {
      await withBrowserFollowupSecondWindow(
        {
          browser: browser as never,
          owner: {
            until: async (check) => {
              events.push("restored-receipt");
              expect(await check()).toBe(true);
            },
          },
          threadRoute: "http://127.0.0.1:4885/local/owned-thread",
          label: "Terminal 1",
          readTerminalReceipt: () => ({
            sameTerminalMatched: true,
            twoAttachmentsObserved: true,
            distinctSizeClaims: true,
            originalOutputMatched: true,
            sizeOwnerMatched: true,
          }),
          verifyFit: () => {},
          verifyRestored: () => {},
          prepareOriginalSizeOwner: async () => {
            events.push("setup-pointer");
            if (mode === "setup-undefined") throw undefined;
          },
          restoreOriginalSizeOwner: async () => {
            events.push("restore-pointer");
            if (mode !== "owned") throw original;
          },
          observeUnsafeCleanup: () => {
            unsafe++;
          },
        },
        async (scope) => {
          await scope.prepareOriginalSizeOwner();
          events.push("source-capture");
        },
      );
    } catch (error) {
      failed = true;
      caught = error;
    }
    expect(handles).toEqual(["main"]);
    expect(handle).toBe("main");
    expect(events.indexOf("close")).toBeLessThan(events.indexOf("size:960"));
    expect(events.indexOf("size:960")).toBeLessThan(events.indexOf("restore-pointer"));
    expect(events.filter((x) => x === "setup-pointer")).toHaveLength(1);
    expect(events.filter((x) => x === "restore-pointer")).toHaveLength(1);
    if (mode === "owned") {
      expect(failed).toBe(false);
      expect(events.at(-1)).toBe("restored-receipt");
      expect(unsafe).toBe(0);
    } else {
      expect(failed).toBe(true);
      if (mode === "setup-undefined") expect(caught).toBeUndefined();
      else expect(caught).toEqual(new Error("Owned browser follow-up resource refused."));
      expect(unsafe).toBe(1);
    }
  },
);
