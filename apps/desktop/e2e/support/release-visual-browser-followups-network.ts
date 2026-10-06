// @effect-diagnostics nodeBuiltinImport:off - CI-only owned loopback raw HTTP/WebSocket transport.
import * as NodeNet from "node:net";
import { createBrowserFollowupReplyGate } from "./release-visual-browser-followups-transport.ts";
import type { createBrowserFollowupProtocolObserver } from "./release-visual-browser-followups-protocol.ts";
import { createBrowserFollowupProtocolObserver as createObserver } from "./release-visual-browser-followups-protocol.ts";
import { startThrottleProxy, type ThrottleProxy } from "../../../../scripts/throttle-proxy.ts";
const refused = () => new Error("Owned browser follow-up network refused.");
/** Publish one teardown result before starting it, including synchronous/reentrant fake-port callbacks. */
function retainNetworkClose(run: () => Promise<void>): () => Promise<void> {
  let joined: Promise<void> | undefined;
  return () => {
    if (joined) return joined;
    let resolve!: () => void, reject!: (error: unknown) => void;
    joined = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    void run().then(resolve, reject);
    return joined;
  };
}
/** One concrete #17 chain; the shared caller receives only the public paced endpoint. */
export async function startBrowserFollowupNetwork(input: {
  CI: string | undefined;
  listenPort: number;
  targetPort: number;
  png: Buffer;
  cwd: string;
  threadId: string;
  terminalId: string;
  patch: () => string;
  observeUnsafeCleanup: () => void;
}) {
  const wirePort = 4894;
  if (
    input.CI !== "true" ||
    [input.listenPort, input.targetPort].includes(wirePort) ||
    input.listenPort === input.targetPort ||
    ![input.listenPort, input.targetPort].every(
      (value) => Number.isInteger(value) && value >= 4880 && value <= 4999,
    )
  )
    throw refused();
  let proxy: ThrottleProxy | undefined;
  const observer = createObserver({
    png: input.png,
    cwd: input.cwd,
    threadId: input.threadId,
    terminalId: input.terminalId,
    patch: input.patch,
    slowTransport: () => {
      const value = proxy?.settings();
      return value?.up === 4096 && value.down === 0 && !value.frozen;
    },
  });
  const transport = await startBrowserFollowupTransport({
    CI: input.CI,
    listenPort: wirePort,
    targetPort: input.targetPort,
    observer,
  });
  try {
    proxy = await startThrottleProxy({
      listenHost: "127.0.0.1",
      listenPort: input.listenPort,
      targetHost: "127.0.0.1",
      targetPort: wirePort,
    });
  } catch (error) {
    try {
      await transport.close();
    } catch {
      try {
        input.observeUnsafeCleanup();
      } catch {
        /* Keep the original failure. */
      }
    }
    throw error;
  }
  return {
    port: proxy.port,
    proxy,
    transport,
    observer,
    close: retainNetworkClose(async () => {
      let unsafe = false,
        original: unknown;
      try {
        await proxy!.close();
      } catch (error) {
        unsafe = true;
        original = error;
      }
      try {
        await transport.close();
      } catch (error) {
        if (!unsafe) original = error;
        unsafe = true;
      }
      if (unsafe) {
        try {
          input.observeUnsafeCleanup();
        } catch {
          /* Keep cleanup refusal authoritative. */
        }
        throw original;
      }
    }),
  };
}
/** HTTP stays original. Only the original selected diagnostics reply is held after an actual WebSocket upgrade. */
export async function startBrowserFollowupTransport(input: {
  CI: string | undefined;
  listenPort: number;
  targetPort: number;
  observer: ReturnType<typeof createBrowserFollowupProtocolObserver>;
}) {
  if (
    input.CI !== "true" ||
    ![input.listenPort, input.targetPort].every(
      (value) => Number.isInteger(value) && value >= 4880 && value <= 4999,
    ) ||
    input.listenPort === input.targetPort
  )
    throw refused();
  const sockets = new Set<NodeNet.Socket>();
  const wires = new Map<
    string,
    {
      gate: ReturnType<typeof createBrowserFollowupReplyGate>;
      upstream: NodeNet.Socket;
      client: NodeNet.Socket;
      upgraded: boolean;
    }
  >();
  let ordinal = 0,
    closed = false,
    failed = false,
    cleanupComplete = false,
    cleanupFailed = false,
    slowKey: string | null = null;
  const server = NodeNet.createServer((client) => {
    if (closed || ++ordinal > 128) {
      client.destroy();
      return;
    }
    const connection = "connection-" + ordinal;
    const upstream = NodeNet.connect(input.targetPort, "127.0.0.1");
    const gate = createBrowserFollowupReplyGate({
      observeOriginal: (direction, value) => input.observer.observe(connection, direction, value),
    });
    const wire = { gate, upstream, client, upgraded: false };
    wires.set(connection, wire);
    sockets.add(client);
    sockets.add(upstream);
    let requestPending = Buffer.alloc(0),
      replyPending = Buffer.alloc(0),
      requestClassified = false,
      replyClassified = false,
      wantsUpgrade = false;
    const destroy = () => {
      gate.close();
      input.observer.connectionClosed(connection);
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
      wires.delete(connection);
    };
    const write = (source: NodeNet.Socket, destination: NodeNet.Socket, bytes: Buffer) => {
      if (!destination.write(bytes)) {
        source.pause();
        destination.once("drain", () => {
          if (!closed && !source.destroyed) source.resume();
        });
      }
    };
    client.on("data", (bytes: Buffer) => {
      try {
        if (!requestClassified) {
          requestPending = Buffer.concat([requestPending, bytes]);
          const end = requestPending.indexOf("\r\n\r\n");
          if (end < 0) {
            if (requestPending.length > 16384) throw refused();
            return;
          }
          if (end > 16380) throw refused();
          const header = requestPending.subarray(0, end + 4);
          wantsUpgrade = /^Upgrade:\s*websocket\s*\r?$/im.test(header.toString("ascii"));
          requestClassified = true;
          write(client, upstream, header);
          bytes = requestPending.subarray(end + 4);
          requestPending = Buffer.alloc(0);
          if (!bytes.length) return;
        }
        if (!wantsUpgrade) write(client, upstream, bytes);
        else for (const original of gate.client(bytes)) write(client, upstream, original);
      } catch {
        failed = true;
        destroy();
      }
    });
    upstream.on("data", (bytes: Buffer) => {
      try {
        if (!replyClassified && wantsUpgrade) {
          replyPending = Buffer.concat([replyPending, bytes]);
          const end = replyPending.indexOf("\r\n\r\n");
          if (end < 0) {
            if (replyPending.length > 16384) throw refused();
            return;
          }
          if (
            end > 16380 ||
            !/^HTTP\/1\.[01] 101 [^\r\n]*\r\n/.test(
              replyPending.subarray(0, end + 4).toString("ascii"),
            )
          )
            throw refused();
          replyClassified = true;
          wire.upgraded = true;
          write(upstream, client, replyPending.subarray(0, end + 4));
          bytes = replyPending.subarray(end + 4);
          replyPending = Buffer.alloc(0);
          if (!bytes.length) return;
        }
        if (!wantsUpgrade) write(upstream, client, bytes);
        else for (const original of gate.server(bytes)) write(upstream, client, original);
      } catch {
        failed = true;
        destroy();
      }
    });
    client.on("error", () => {
      failed = true;
      destroy();
    });
    upstream.on("error", () => {
      failed = true;
      destroy();
    });
    client.on("close", destroy);
    upstream.on("close", destroy);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.listenPort, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    arm: () => {
      const admitted = [...wires.entries()].filter(
        ([connection, wire]) =>
          wire.upgraded &&
          !wire.gate.observation().closed &&
          input.observer.rendererConnection(connection),
      );
      if (closed || failed || slowKey !== null || admitted.length !== 1) throw refused();
      slowKey = admitted[0]![0];
      admitted[0]![1].gate.arm();
    },
    verifyHeld: () => {
      const wire = slowKey === null ? null : wires.get(slowKey);
      if (closed || failed || !wire) throw refused();
      return wire.gate.verifyHeld();
    },
    release: () => {
      const wire = slowKey === null ? null : wires.get(slowKey);
      if (closed || failed || !wire) throw refused();
      for (const original of wire.gate.release()) wire.client.write(original);
    },
    observation: () => ({
      closed,
      failed,
      cleanupComplete,
      cleanupFailed,
      upgradedConnections: [...wires.values()].filter((value) => value.upgraded).length,
      heldReplies: [...wires.values()].filter((value) => value.gate.observation().replyHeld).length,
    }),
    close: retainNetworkClose(async () => {
      closed = true;
      let unsafe = false,
        original: unknown;
      const attempt = async (run: () => void | Promise<void>) => {
        try {
          await run();
        } catch (error) {
          if (!unsafe) original = error;
          unsafe = true;
        }
      };
      for (const wire of wires.values()) await attempt(() => wire.gate.close());
      for (const socket of sockets)
        await attempt(() => {
          socket.destroy();
        });
      await attempt(
        () =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      );
      wires.clear();
      sockets.clear();
      await attempt(() => input.observer.close());
      if (unsafe) {
        cleanupFailed = true;
        failed = true;
        throw original;
      }
      cleanupComplete = true;
    }),
  };
}
