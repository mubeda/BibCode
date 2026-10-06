// @effect-diagnostics nodeBuiltinImport:off - Fixed CI-only loopback sockets are test fixtures, never production helpers.
// @effect-diagnostics globalTimers:off - Owned drain/hold/close bounds are cancelled and joined.
import * as NodeNet from "node:net";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import { HostProcessPlatform } from "../../../../packages/shared/src/hostProcess.ts";
import { bounded } from "./qualification-owner.ts";
import {
  createSettingsConfigurationGate,
  type SettingsConfigurationGate,
} from "./release-visual-settings-followups-transport.ts";
const Effect = NodeModule.createRequire(
  new NodeURL.URL("../../../../packages/shared/package.json", import.meta.url),
)("effect/Effect");
export interface SettingsFollowupSocket {
  readonly destroyed: boolean;
  on(event: "data", listener: (bytes: Buffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  once(event: "drain", listener: () => void): unknown;
  write(bytes: Buffer): boolean;
  pause(): unknown;
  resume(): unknown;
  destroy(): unknown;
}
export interface SettingsFollowupSocketServer {
  on(event: "error", listener: (error: Error) => void): unknown;
  listen(port: number, host: string, ready: () => void): unknown;
  close(done: (error?: Error) => void): unknown;
}
export interface SettingsFollowupSocketPorts {
  createServer: (accept: (client: SettingsFollowupSocket) => void) => SettingsFollowupSocketServer;
  connect: (port: number, host: string) => SettingsFollowupSocket;
  schedule: (run: () => void, ms: number) => unknown;
  cancel: (timer: unknown) => void;
}
export interface SettingsFollowupSocketOwner {
  armNextConfiguration: () => Promise<void>;
  verifyHolding: () => Promise<void>;
  release: () => Promise<void>;
  close: () => Promise<void>;
  observation: () => {
    activeNoiseConnections: number;
    acceptedNoiseConnections: number;
    holding: boolean;
    heldBytes: number;
    closed: boolean;
  };
}
function liveSocketPorts(): SettingsFollowupSocketPorts {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  return {
    createServer: (accept) => NodeNet.createServer(accept),
    connect: (port, host) => NodeNet.connect(port, host),
    schedule: (run, ms) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        run();
      }, ms);
      timers.add(timer);
      return timer;
    },
    cancel: (value) => {
      for (const timer of timers)
        if (timer === value) {
          clearTimeout(timer);
          timers.delete(timer);
        }
    },
  };
}
export async function startSettingsFollowupSocket(input: {
  CI: string | undefined;
  platform: string;
  admitOwner: () => Promise<void>;
  ports?: SettingsFollowupSocketPorts;
  observeUnsafeCleanup?: () => void;
}): Promise<SettingsFollowupSocketOwner> {
  const refused = () => new Error("Owned settings socket admission refused.");
  if (
    input.CI !== "true" ||
    input.platform !== "linux" ||
    (input.ports === undefined && Effect.runSync(HostProcessPlatform) !== "linux")
  )
    throw refused();
  await input.admitOwner();
  const ports = input.ports ?? liveSocketPorts();
  interface Peer {
    client: SettingsFollowupSocket;
    upstream: SettingsFollowupSocket;
    header: Buffer | null;
    noise: boolean;
    gate: SettingsConfigurationGate | null;
    pending: Promise<void>;
    timer: unknown;
    upgraded: boolean;
    closed: boolean;
  }
  const peers = new Set<Peer>();
  let armed = false,
    armedOnce = false,
    closed = false,
    listenerClosed = false,
    accepted = 0,
    failure: Error | null = null,
    heldPeer: Peer | null = null;
  let closing: Promise<void> | undefined;
  const destroy = (peer: Peer, cause?: Error) => {
    if (cause && (peer.noise || peer === heldPeer) && failure === null) failure = cause;
    if (peer.closed) return;
    peer.closed = true;
    ports.cancel(peer.timer);
    peer.timer = undefined;
    peer.gate?.close();
    peer.client.destroy();
    peer.upstream.destroy();
    peers.delete(peer);
  };
  const write = async (socket: SettingsFollowupSocket, bytes: Buffer) => {
    if (socket.destroyed) throw refused();
    if (socket.write(bytes)) return;
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const timer = ports.schedule(() => {
        if (!done) {
          done = true;
          reject(refused());
        }
      }, 2000);
      socket.once("drain", () => {
        if (!done) {
          done = true;
          ports.cancel(timer);
          resolve();
        }
      });
      socket.on("close", () => {
        if (!done) {
          done = true;
          ports.cancel(timer);
          reject(refused());
        }
      });
    });
  };
  const enqueue = (
    peer: Peer,
    source: SettingsFollowupSocket,
    destination: SettingsFollowupSocket,
    bytes: readonly Buffer[],
  ) => {
    source.pause();
    peer.pending = peer.pending
      .then(async () => {
        for (const chunk of bytes) await write(destination, chunk);
        if (!peer.closed && (peer.gate?.observation().heldBytes ?? 0) < 262144) source.resume();
      })
      .catch((cause) => destroy(peer, cause instanceof Error ? cause : refused()));
  };
  const server = ports.createServer((client) => {
    if (closed || failure !== null || peers.size >= 16) {
      client.destroy();
      return;
    }
    const upstream = ports.connect(4888, "127.0.0.1");
    const peer: Peer = {
      client,
      upstream,
      header: Buffer.alloc(0),
      noise: false,
      gate: null,
      pending: Promise.resolve(),
      timer: undefined,
      upgraded: false,
      closed: false,
    };
    peers.add(peer);
    client.on("error", (error) => destroy(peer, error));
    upstream.on("error", (error) => destroy(peer, error));
    client.on("close", () => destroy(peer));
    upstream.on("close", () => destroy(peer));
    client.on("data", (bytes) => {
      try {
        if (peer.closed || !Buffer.isBuffer(bytes) || bytes.length > 1_048_576) throw refused();
        if (peer.header !== null) {
          peer.header = Buffer.concat([peer.header, bytes]);
          const end = peer.header.indexOf("\r\n\r\n");
          if (end === -1) {
            if (peer.header.length > 16384) throw refused();
          } else {
            if (end + 4 > 16384) throw refused();
            const first = peer.header.subarray(0, peer.header.indexOf("\r\n")).toString("ascii");
            peer.noise = first === "GET /ws-e2ee HTTP/1.1";
            if (peer.noise) {
              const hold = armed;
              if (hold) {
                if (heldPeer !== null) throw refused();
                heldPeer = peer;
                armed = false;
              }
              peer.gate = createSettingsConfigurationGate(hold ? "hold-config" : "pass");
            }
            peer.header = null;
          }
        }
        enqueue(peer, client, upstream, [Buffer.from(bytes)]);
      } catch (cause) {
        destroy(peer, cause instanceof Error ? cause : refused());
      }
    });
    upstream.on("data", (bytes) => {
      try {
        if (peer.closed || !Buffer.isBuffer(bytes) || bytes.length > 1_048_576) throw refused();
        const output = peer.gate?.push(bytes) ?? [Buffer.from(bytes)],
          observed = peer.gate?.observation();
        if (observed?.upgradeObserved && !peer.upgraded) {
          peer.upgraded = true;
          if (++accepted > 32) throw refused();
        }
        if (
          peer === heldPeer &&
          observed?.forwardedPreapplicationMessages === 2 &&
          peer.timer === undefined
        ) {
          peer.timer = ports.schedule(() => destroy(peer, refused()), 20000);
        }
        enqueue(peer, upstream, client, output);
      } catch (cause) {
        destroy(peer, cause instanceof Error ? cause : refused());
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.on("error", (error) => {
        if (failure === null) failure = error;
        for (const peer of peers) destroy(peer, error);
        reject(error);
      });
      server.listen(4889, "127.0.0.1", resolve);
    });
  } catch (error) {
    closed = true;
    for (const peer of peers) destroy(peer);
    try {
      await bounded(
        new Promise<void>((resolve, reject) =>
          server.close((cause) => (cause ? reject(cause) : resolve())),
        ),
        2000,
      );
    } catch {
      try {
        input.observeUnsafeCleanup?.();
      } catch {
        /* Original initialization error stays primary. */
      }
    }
    throw error;
  }
  const holding = () => {
    if (closed || failure !== null || heldPeer === null || heldPeer.closed)
      throw failure ?? refused();
    const observed = heldPeer.gate?.observation();
    if (
      !observed ||
      observed.closed ||
      observed.released ||
      !observed.upgradeObserved ||
      observed.forwardedPreapplicationMessages !== 2 ||
      observed.heldRecords === 0 ||
      Array.from(peers).filter((peer) => peer.noise && !peer.closed).length !== 1
    )
      throw refused();
    return heldPeer;
  };
  return {
    armNextConfiguration: async () => {
      await input.admitOwner();
      if (
        closed ||
        failure !== null ||
        armed ||
        armedOnce ||
        heldPeer !== null ||
        Array.from(peers).some((peer) => peer.noise && !peer.closed)
      )
        throw failure ?? refused();
      armed = true;
      armedOnce = true;
    },
    verifyHolding: async () => {
      await input.admitOwner();
      const peer = holding();
      await peer.pending;
      holding();
    },
    release: async () => {
      await input.admitOwner();
      const peer = holding();
      await peer.pending;
      const bytes = peer.gate!.release();
      ports.cancel(peer.timer);
      peer.timer = undefined;
      enqueue(peer, peer.upstream, peer.client, bytes);
      await peer.pending;
      if (peer.closed || failure !== null) throw failure ?? refused();
      peer.upstream.resume();
      heldPeer = null;
    },
    close: () => {
      if (closing) return closing;
      closed = true;
      armed = false;
      const owned = Array.from(peers);
      for (const peer of owned) destroy(peer);
      closing = (async () => {
        await Promise.all(owned.map((peer) => peer.pending));
        await bounded(
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
          2000,
        );
        if (peers.size !== 0) throw refused();
        listenerClosed = true;
      })();
      return closing;
    },
    observation: () => {
      const state = heldPeer?.gate?.observation();
      return {
        activeNoiseConnections: Array.from(peers).filter((peer) => peer.noise && !peer.closed)
          .length,
        acceptedNoiseConnections: accepted,
        holding: state !== undefined && !state.closed && !state.released && state.heldRecords > 0,
        heldBytes: state?.heldBytes ?? 0,
        closed: closed && listenerClosed,
      };
    },
  };
}
export async function withSettingsFollowupSocket<A>(
  input: Parameters<typeof startSettingsFollowupSocket>[0] & { observeUnsafeCleanup: () => void },
  run: (owner: SettingsFollowupSocketOwner) => Promise<A>,
): Promise<A> {
  const owner = await startSettingsFollowupSocket(input);
  let failed = false,
    error: unknown,
    value: A | undefined;
  try {
    value = await run(owner);
  } catch (cause) {
    failed = true;
    error = cause;
  }
  let cleanupFailed = false;
  try {
    await owner.close();
  } catch {
    cleanupFailed = true;
    try {
      input.observeUnsafeCleanup();
    } catch {
      /* Original and cleanup outcomes remain primary. */
    }
  }
  if (failed) throw error;
  if (cleanupFailed) throw new Error("Owned settings socket cleanup refused.");
  return value as A;
}
