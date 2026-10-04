// @effect-diagnostics nodeBuiltinImport:off - Owned protocol fixture joins only its ephemeral loopback listener and sockets.
// @effect-diagnostics globalTimers:off - Test-only operation and cleanup bounds always clear their owned timers.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import * as NodeStream from "node:stream";
import { describe, expect, it } from "vite-plus/test";
import { requireInlineProbeOwner, createInlineProbeControl } from "./chat-inline-receiver.ts";
import { createNativeFrameRecorder } from "./chat-inline-mechanics.ts";
import { startThrottleProxy } from "../../../../scripts/throttle-proxy.ts";
async function ownedTestBound<A>(
  operation: Promise<A>,
  milliseconds: number,
  failure: Error,
): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(failure), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
it("rejects an owned operation deadline instead of leaving a stalled promise pending", async () => {
  const failure = new Error("Controlled owned test deadline.");
  let fallback: ReturnType<typeof setTimeout> | undefined;
  try {
    const observed = await Promise.race([
      ownedTestBound(new Promise<never>(() => {}), 10, failure).catch((error: unknown) => error),
      new Promise<string>((resolve) => {
        fallback = setTimeout(() => resolve("deadline-missing"), 30);
      }),
    ]);
    expect(observed).toBe(failure);
  } finally {
    clearTimeout(fallback);
  }
});
const owner = {
  linux: true,
  ci: true,
  privateNet: true,
  netMatches: true,
  pidMatches: true,
  userMatches: true,
  pid1NetMatches: true,
  pid1PidMatches: true,
  pid1UserMatches: true,
  networkPrepared: true,
  browserOnline: true,
  contained: true,
};
describe("inline transport fixture admission", () => {
  it("admits the complete closed owner proof for the guarded live producer", () => {
    expect(() => requireInlineProbeOwner(owner)).not.toThrow();
  });
  it.each(Object.keys(owner))(
    "refuses the missing %s ownership proof before any listener admission",
    (key) => {
      expect(() => requireInlineProbeOwner({ ...owner, [key]: false })).toThrow(
        "Inline probe owner refused.",
      );
    },
  );
  it("refuses extra or incomplete ownership proof", () => {
    expect(() => requireInlineProbeOwner({ ...owner, rawNamespace: "private" })).toThrow();
    expect(() => requireInlineProbeOwner({ linux: true })).toThrow();
  });
});

type FixtureCleanupReceipt = {
  cleanupJoined: boolean;
  serverListening: boolean;
  serverSockets: number;
  proxyActive: number | null;
  clientCloseObserved: boolean;
  closeSuppressed: boolean;
};
const cleanupReceipt = (): FixtureCleanupReceipt => ({
  cleanupJoined: false,
  serverListening: false,
  serverSockets: 0,
  proxyActive: null,
  clientCloseObserved: false,
  closeSuppressed: false,
});
async function runOwnedProxyFixture(
  receipt: FixtureCleanupReceipt,
  fault: "stall-close" | "refuse-open" | "refuse-listener" | null = null,
) {
  const deadlineError = new Error("Owned fixture operation deadline exceeded.");
  const expectedDigest = NodeCrypto.createHash("sha256")
    .update(Buffer.alloc(3145728, 65))
    .digest("hex");
  const recorder = createNativeFrameRecorder(3145728, expectedDigest);
  const sockets = new Set<NodeStream.Duplex>();
  const joins: Promise<void>[] = [];
  const server = NodeHttp.createServer();
  let stopped = false;
  const ensureRunning = () => {
    if (stopped) throw deadlineError;
  };
  let rejectListener: (error: Error) => void = () => {};
  const listenerFailure = new Promise<never>((_, reject) => {
    rejectListener = reject;
  });
  server.on("error", () => rejectListener(new Error("Owned fixture listener refused.")));
  server.on("connection", (socket) => {
    sockets.add(socket);
    joins.push(
      new Promise<void>((resolve) =>
        socket.once("close", () => {
          sockets.delete(socket);
          resolve();
        }),
      ),
    );
    socket.on("error", () => socket.destroy());
    if (stopped) socket.destroy();
  });
  let control: ReturnType<typeof createInlineProbeControl> | undefined;
  server.on("upgrade", (request, socket, head) => {
    if (stopped || fault === "refuse-open") {
      socket.destroy();
      return;
    }
    socket.once("close", () => recorder.end());
    const accept = NodeCrypto.createHash("sha1")
      .update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
        accept +
        "\r\n\r\n",
    );
    const port =
      fault === "stall-close"
        ? {
            write: (chunk: unknown) => {
              if (Buffer.isBuffer(chunk) && chunk[0] === 0x88) {
                receipt.closeSuppressed = true;
                return true;
              }
              return socket.write(chunk as Buffer);
            },
            end: () => socket.end(),
            destroy: () => socket.destroy(),
          }
        : socket;
    control = createInlineProbeControl("mid-message-pong", recorder, port, () => stopped);
    socket.on("data", control.receive);
    if (head.length) control.receive(head);
  });
  let proxy: Awaited<ReturnType<typeof startThrottleProxy>> | undefined;
  let proxyPending: Promise<Awaited<ReturnType<typeof startThrottleProxy>>> | undefined;
  let client: WebSocket | undefined;
  let clientJoined: Promise<CloseEvent> | undefined;
  const run = async () => {
    await new Promise<void>((resolve, reject) => {
      const failed = () => reject(new Error("Owned fixture listener refused."));
      server.once("error", failed);
      if (fault === "refuse-listener") {
        server.emit("error", new Error("Controlled fixture listener error."));
        return;
      }
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", failed);
        resolve();
      });
    });
    ensureRunning();
    const target = server.address();
    if (typeof target !== "object" || !target) throw new Error("Owned fixture listener refused.");
    proxyPending = startThrottleProxy({
      listenHost: "127.0.0.1",
      listenPort: 0,
      targetHost: "127.0.0.1",
      targetPort: target.port,
    }).then(async (owned) => {
      proxy = owned;
      if (stopped) {
        await owned.close();
        throw deadlineError;
      }
      return owned;
    });
    await proxyPending;
    ensureRunning();
    client = new WebSocket("ws://127.0.0.1:" + proxy!.port + "/inline-probe");
    clientJoined = new Promise<CloseEvent>((resolve) =>
      client!.addEventListener(
        "close",
        (event) => {
          receipt.clientCloseObserved = true;
          resolve(event);
        },
        { once: true },
      ),
    );
    await new Promise<void>((resolve, reject) => {
      const refused = () => reject(new Error("Owned fixture client refused."));
      client!.addEventListener("open", () => resolve(), { once: true });
      client!.addEventListener("error", refused, { once: true });
      client!.addEventListener("close", refused, { once: true });
    });
    ensureRunning();
    client.send("A".repeat(3145728));
    const closed = await clientJoined;
    ensureRunning();
    await Promise.all(joins);
    ensureRunning();
    expect(closed.code).toBe(1000);
    expect(closed.wasClean).toBe(true);
    expect(control!.closeWritten()).toBe(true);
    expect(recorder.read()).toMatchObject({
      complete: true,
      messageBytes: 3145728,
      messageFinished: true,
      messageDigest: expectedDigest,
      nativePingWritesMidMessage: 1,
      nativePongAfterMessage: 1,
      closeFrameReceived: true,
      closeAfterMessage: true,
      partialFrame: false,
    });
  };
  try {
    await ownedTestBound(Promise.race([run(), listenerFailure]), 3000, deadlineError);
  } finally {
    stopped = true;
    const cleanup = async () => {
      try {
        if (client && client.readyState < 2) client.close(1000);
      } finally {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
        await Promise.all([
          proxy?.close(),
          proxyPending?.then(
            (owned) => owned.close(),
            () => undefined,
          ),
          serverClosed,
          clientJoined,
        ]);
        await Promise.all(joins);
      }
    };
    await ownedTestBound(cleanup(), 1000, new Error("Owned fixture cleanup deadline exceeded."));
    receipt.serverListening = server.listening;
    receipt.serverSockets = sockets.size;
    receipt.proxyActive = proxy?.measurements().connections.active ?? null;
    receipt.cleanupJoined = true;
    expect(receipt).toMatchObject({
      cleanupJoined: true,
      serverListening: false,
      serverSockets: 0,
    });
    expect(receipt.proxyActive).toBe(proxy ? 0 : null);
    expect(receipt.clientCloseObserved).toBe(client !== undefined);
  }
}
it("receives the client's matching Close through the real proxy before ending the native stream", async () => {
  await runOwnedProxyFixture(cleanupReceipt());
});
it.each(["stall-close", "refuse-open", "refuse-listener"] as const)(
  "rejects %s into finally and joins only its exact owned fixture resources",
  async (fault) => {
    const receipt = cleanupReceipt();
    await expect(runOwnedProxyFixture(receipt, fault)).rejects.toThrow(
      fault === "stall-close"
        ? "Owned fixture operation deadline exceeded."
        : fault === "refuse-open"
          ? "Owned fixture client refused."
          : "Owned fixture listener refused.",
    );
    expect(receipt).toMatchObject({
      cleanupJoined: true,
      serverListening: false,
      serverSockets: 0,
      proxyActive: fault === "refuse-listener" ? null : 0,
      clientCloseObserved: fault !== "refuse-listener",
      closeSuppressed: fault === "stall-close",
    });
  },
);

function maskedFrame(opcode: number, payload: Buffer) {
  const extra = payload.length < 126 ? 0 : payload.length < 65536 ? 2 : 8;
  const wire = Buffer.alloc(6 + extra + payload.length);
  wire[0] = 128 | opcode;
  wire[1] = 128 | (extra === 0 ? payload.length : extra === 2 ? 126 : 127);
  if (extra === 2) wire.writeUInt16BE(payload.length, 2);
  if (extra === 8) wire.writeBigUInt64BE(BigInt(payload.length), 2);
  const mask = [1, 2, 3, 4];
  wire.set(mask, 2 + extra);
  for (let index = 0; index < payload.length; index++)
    wire[6 + extra + index] = payload[index]! ^ mask[index % 4]!;
  return wire;
}
function controlFixture(action: "mid-message-pong" | "queued-before-close") {
  const payload = Buffer.alloc(3145728, 65);
  const recorder = createNativeFrameRecorder(
    payload.length,
    NodeCrypto.createHash("sha256").update(payload).digest("hex"),
  );
  const socket = new NodeStream.PassThrough();
  const writes: Buffer[] = [];
  socket.on("data", (value: Buffer) => writes.push(value));
  let stopped = false;
  const control = createInlineProbeControl(action, recorder, socket, () => stopped);
  const data = maskedFrame(1, payload);
  const pong = maskedFrame(10, Buffer.from([17, 0, 17, 0]));
  const close = maskedFrame(8, Buffer.from([3, 232]));
  return {
    recorder,
    socket,
    writes,
    control,
    data,
    pong,
    close,
    stop: () => {
      stopped = true;
    },
  };
}
describe("owned inline Close handshake", () => {
  it("writes native Close once after message/Pong and keeps TCP open until the exact client Close", () => {
    const f = controlFixture("mid-message-pong");
    try {
      f.control.receive(f.data.subarray(0, 32782));
      f.control.receive(f.data.subarray(32782));
      f.control.receive(f.pong);
      expect(f.control.closeWritten()).toBe(true);
      expect(f.socket.writableEnded).toBe(false);
      expect(f.recorder.read()).toMatchObject({
        complete: true,
        closeFrameReceived: false,
        nativePongAfterMessage: 1,
      });
      f.control.receive(f.close);
      expect(f.socket.writableEnded).toBe(true);
      f.recorder.end();
      expect(f.recorder.read()).toMatchObject({
        complete: true,
        closeFrameReceived: true,
        closeAfterMessage: true,
      });
      expect(Buffer.concat(f.writes)).toEqual(
        Buffer.from([0x89, 4, 17, 0, 17, 0, 0x88, 2, 3, 232]),
      );
    } finally {
      f.socket.destroy();
    }
  });
  it("keeps queued-before-close data and exact Close echo order without inventing a Ping", () => {
    const f = controlFixture("queued-before-close");
    try {
      f.control.receive(f.data);
      expect(f.socket.writableEnded).toBe(false);
      expect(f.control.closeWritten()).toBe(false);
      f.control.receive(f.close);
      f.recorder.end();
      expect(f.recorder.read()).toMatchObject({
        complete: true,
        closeAfterMessage: true,
        nativePingWritesMidMessage: 0,
        nativePongAfterMessage: 0,
        nativePongMidMessage: 0,
      });
      expect(f.socket.writableEnded).toBe(true);
      expect(Buffer.concat(f.writes)).toEqual(Buffer.from([0x88, 2, 3, 232]));
    } finally {
      f.socket.destroy();
    }
  });
  it("still refuses a mismatched client Close instead of converting it to matching receipt", () => {
    const f = controlFixture("queued-before-close");
    try {
      f.control.receive(f.data);
      f.control.receive(maskedFrame(8, Buffer.from([3, 233])));
      expect(f.socket.destroyed).toBe(true);
      expect(f.recorder.read()).toMatchObject({
        complete: false,
        closeFrameReceived: false,
        closeAfterMessage: false,
      });
      expect(f.control.closeWritten()).toBe(false);
    } finally {
      f.socket.destroy();
    }
  });
  it("fences data/Pong/Close after the existing owner stop without sending late controls", () => {
    const f = controlFixture("mid-message-pong");
    try {
      f.control.receive(f.data.subarray(0, 32782));
      const before = f.recorder.read();
      f.stop();
      f.control.receive(f.data.subarray(32782));
      f.control.receive(f.pong);
      f.control.receive(f.close);
      expect(f.recorder.read()).toEqual(before);
      expect(f.socket.writableEnded).toBe(false);
      expect(f.control.closeWritten()).toBe(false);
      expect(Buffer.concat(f.writes)).toEqual(Buffer.from([0x89, 4, 17, 0, 17, 0]));
    } finally {
      f.socket.destroy();
    }
  });
});
