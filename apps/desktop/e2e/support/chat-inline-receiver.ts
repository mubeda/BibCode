// @effect-diagnostics nodeBuiltinImport:off - Development-only fixture owns its contained listener and sockets.
// @effect-diagnostics globalTimers:off - Probe-only absolute deadline and joined shutdown.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import type * as NodeStream from "node:stream";
import type { BrowserNetworkProof } from "./browser-network.ts";
import { createNativeFrameRecorder, type BrowserInlineAction } from "./chat-inline-mechanics.ts";

/** The live producer below derives every bit from native identities and the existing network proof. */
export function requireInlineProbeOwner(owner: unknown): void {
  const keys = [
    "linux",
    "ci",
    "privateNet",
    "netMatches",
    "pidMatches",
    "userMatches",
    "pid1NetMatches",
    "pid1PidMatches",
    "pid1UserMatches",
    "networkPrepared",
    "browserOnline",
    "contained",
  ];
  if (
    owner === null ||
    typeof owner !== "object" ||
    Array.isArray(owner) ||
    Object.keys(owner).length !== keys.length ||
    !keys.every((key) => Reflect.get(owner, key) === true)
  )
    throw new Error("Inline probe owner refused.");
}

function verifyLiveOwner(proof: BrowserNetworkProof): void {
  const identities = (kind: "net" | "pid" | "user") => {
    const self = NodeFS.readlinkSync("/proc/self/ns/" + kind);
    return {
      matches: self === process.env["BIBCODE_UPLOAD_" + kind.toUpperCase() + "NS"],
      ownerMatches: self === NodeFS.readlinkSync("/proc/1/ns/" + kind),
      private:
        /^net:\[\d+\]$/.test(process.env.BIBCODE_UPLOAD_HOST_NETNS ?? "") &&
        self !== process.env.BIBCODE_UPLOAD_HOST_NETNS,
    };
  };
  // oxlint-disable-next-line bibcode/no-global-process-runtime -- The security admission checks the actual native host before reading Linux namespaces.
  if (process.platform !== "linux" || process.env.CI !== "true")
    throw new Error("Inline probe owner refused.");
  try {
    const net = identities("net"),
      pid = identities("pid"),
      user = identities("user");
    const containment = proof.containment;
    requireInlineProbeOwner({
      linux: true,
      ci: true,
      privateNet: net.private,
      netMatches: net.matches,
      pidMatches: pid.matches,
      userMatches: user.matches,
      pid1NetMatches: net.ownerMatches,
      pid1PidMatches: pid.ownerMatches,
      pid1UserMatches: user.ownerMatches,
      networkPrepared: proof.setupRan === true && proof.setupFailure === null,
      browserOnline: proof.after === true,
      contained:
        containment?.privateNet === true &&
        containment.pidOwnerMatches === true &&
        containment.userOwnerMatches === true &&
        containment.loopbackOnlyBefore === true &&
        containment.linksContained === true &&
        containment.routeContained === true &&
        containment.interfaceCount === 3,
    });
  } catch {
    throw new Error("Inline probe owner refused.");
  }
}

/** Listener-free control seam; the live listener still requires its native owner proof. */
export function createInlineProbeControl(
  action: BrowserInlineAction,
  recorder: ReturnType<typeof createNativeFrameRecorder>,
  socket: Pick<NodeStream.Duplex, "write" | "end" | "destroy">,
  isStopped: () => boolean,
) {
  if (action !== "mid-message-pong" && action !== "queued-before-close")
    throw new Error("Inline probe action refused.");
  let pingSent = false,
    closeSent = false;
  const receive = (bytes: Buffer) => {
    if (isStopped()) return;
    recorder.push(bytes);
    const observed = recorder.read();
    if (!observed.complete) {
      socket.destroy();
      return;
    }
    if (
      action === "mid-message-pong" &&
      !pingSent &&
      observed.messageBytes >= 32768 &&
      !observed.messageFinished
    ) {
      try {
        socket.write(Buffer.from([0x89, 4, 17, 0, 17, 0]));
        recorder.recordPingWrite();
        pingSent = true;
      } catch {
        socket.destroy();
        return;
      }
    }
    if (
      !closeSent &&
      (observed.closeFrameReceived ||
        (action === "mid-message-pong" &&
          observed.messageFinished &&
          observed.nativePongMidMessage + observed.nativePongAfterMessage === 1))
    ) {
      closeSent = true;
      socket.write(Buffer.from([0x88, 2, 3, 232]));
    }
    if (observed.closeFrameReceived) socket.end();
  };
  return { receive, closeWritten: () => closeSent };
}

/** Start only inside the existing PID1-owned, no-external-route qualification namespace. */
export async function startInlineProbeReceiver(
  action: BrowserInlineAction,
  proof: BrowserNetworkProof,
) {
  if (action !== "mid-message-pong" && action !== "queued-before-close")
    throw new Error("Inline probe action refused.");
  verifyLiveOwner(proof);
  const messageBytes = 3 * 1024 ** 2;
  const expectedDigest = NodeCrypto.createHash("sha256")
    .update(Buffer.alloc(messageBytes, 65))
    .digest("hex");
  const recorder = createNativeFrameRecorder(messageBytes, expectedDigest);
  const sockets = new Set<NodeStream.Duplex>();
  const joined = new Set<Promise<void>>();
  let stopped = false,
    upgraded = false,
    upgradeCount = 0,
    timedOut = false;
  let control: ReturnType<typeof createInlineProbeControl> | undefined;
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  const server = NodeHttp.createServer({ maxHeaderSize: 8192 }, (request, response) => {
    response.writeHead(request.method === "GET" && request.url === "/" ? 200 : 403, {
      "Content-Type": "text/html",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; connect-src ws://127.0.0.1:4917",
    });
    response.end("<!doctype html><title>Inline transport qualification</title>");
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  server.on("connection", (socket) => {
    if (stopped || sockets.size >= 8) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const done = new Promise<void>((resolve) =>
      socket.once("close", () => {
        sockets.delete(socket);
        resolve();
      }),
    );
    joined.add(done);
    void done.then(() => joined.delete(done));
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("upgrade", (request, socket, head) => {
    // An offered extension is not negotiated. The receiver sends no extension header and refuses RSV bits.
    upgradeCount = Math.min(17, upgradeCount + 1);
    if (
      stopped ||
      upgraded ||
      upgradeCount > 1 ||
      request.method !== "GET" ||
      request.url !== "/inline-probe" ||
      request.headers.host !== "127.0.0.1:4917" ||
      request.headers.upgrade?.toLowerCase() !== "websocket" ||
      !request.headers.connection
        ?.toLowerCase()
        .split(/\s*,\s*/)
        .includes("upgrade") ||
      request.headers["sec-websocket-version"] !== "13" ||
      !["http://127.0.0.1:4916", "http://localhost:4901"].includes(String(request.headers.origin))
    ) {
      socket.destroy();
      return;
    }
    const key = request.headers["sec-websocket-key"];
    if (
      typeof key !== "string" ||
      !/^[A-Za-z0-9+/]{22}==$/.test(key) ||
      Buffer.from(key, "base64").length !== 16 ||
      Buffer.from(key, "base64").toString("base64") !== key
    ) {
      socket.destroy();
      return;
    }
    upgraded = true;
    const accept = NodeCrypto.createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
        accept +
        "\r\n\r\n",
    );
    probeTimer = setTimeout(() => {
      timedOut = true;
      socket.destroy();
    }, 245000);
    control = createInlineProbeControl(action, recorder, socket, () => stopped);
    const receive = control.receive;
    socket.on("data", receive);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      clearTimeout(probeTimer);
      recorder.end();
      socket.removeListener("data", receive);
    });
    if (head.length > 0) receive(head);
  });
  await new Promise<void>((resolve, reject) => {
    const failed = () => reject(new Error("Owned inline listener refused."));
    server.once("error", failed);
    server.listen(4916, "127.0.0.1", () => {
      server.removeListener("error", failed);
      resolve();
    });
  });
  let closing: Promise<void> | undefined;
  return {
    read: () => ({
      ...recorder.read(),
      complete: recorder.read().complete && upgradeCount === 1,
      upgraded,
      upgradeCount,
      timedOut,
      closeWritten: control?.closeWritten() ?? false,
      expectedBytes: messageBytes,
      expectedDigest,
    }),
    close: () =>
      (closing ??= (async () => {
        stopped = true;
        clearTimeout(probeTimer);
        const owned = [...joined];
        for (const socket of sockets) socket.destroy();
        await Promise.all(owned);
        await new Promise<void>((resolve, reject) =>
          server.close((error) =>
            error ? reject(new Error("Owned inline listener cleanup refused.")) : resolve(),
          ),
        );
        recorder.end();
      })()),
  };
}
