// @effect-diagnostics nodeBuiltinImport:off - A development TCP proxy works on raw sockets.
// @effect-diagnostics globalTimers:off - Pacing owns short, bounded timers.
// @effect-diagnostics globalDate:off - Pacing schedules each piece against wall-clock send times.
// @effect-diagnostics globalConsole:off - The CLI prints its bound addresses for the operator.
// @effect-diagnostics globalRandom:off - Jitter only needs an unseeded spread of delays.
/**
 * Throttling TCP proxy for the slow-link liveness runbook
 * (docs/testing/cross-platform-validation.md, "Slow-link liveness scenario")
 * and the high-latency measurement (scripts/measure-remote-latency.ts).
 * It is a development tool and never runs in production.
 *
 * Each direction is paced at its own rate. The proxy stops reading a source
 * while that direction holds 64 KiB beyond what is still in flight, so a slow
 * link makes the sender's socket writes block (backpressure). `delay` holds
 * every byte for that many milliseconds in each direction (a 125 ms delay is a
 * 250 ms round trip), plus up to `jitter` more; bytes never reorder. `frozen`
 * stops both directions without closing either socket.
 *
 *   node scripts/throttle-proxy.ts --listen 127.0.0.1:13854 --target 127.0.0.1:13853 \
 *     --control 127.0.0.1:13855 [--preset 3g] [--down <bytes/s>] [--up <bytes/s>] \
 *     [--delay <ms>] [--jitter <ms>] [--new-connections 1]
 *
 * `--preset 3g` is 400 kbps each way and a 400 ms round trip; an explicit flag overrides it.
 * `--new-connections 1` makes every connection pay its own TCP handshake (one round trip before
 * its first byte) and ends HTTP keep-alive: the first response on a connection says
 * `Connection: close`, so the client's next request opens a new connection. A WebSocket upgrade
 * keeps its connection.
 *
 * Control API: GET /set?preset=3g&down=<B/s>&up=<B/s>&freeze=0|1&delay=<ms>&jitter=<ms>&new-connections=0|1
 * (0 B/s is unlimited); GET /drop closes every open connection; GET /state.
 */
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

export interface LinkSettings {
  /** Server-to-client bytes per second; 0 is unlimited. */
  readonly down: number;
  /** Client-to-server bytes per second; 0 is unlimited. */
  readonly up: number;
  /** Stops forwarding in both directions while true. */
  readonly frozen: boolean;
  /** One-way latency in milliseconds, applied to each direction. */
  readonly delay: number;
  /** Extra one-way latency of up to this many milliseconds, chosen per piece. */
  readonly jitter: number;
  /** Each connection pays a TCP handshake, and an HTTP client cannot reuse one for a second request. */
  readonly newConnections?: boolean;
}

export const UNTHROTTLED: LinkSettings = { down: 0, up: 0, frozen: false, delay: 0, jitter: 0 };

/** Named links. 3g matches T3 Code's preset: 400 kbps each way, a 400 ms round trip. */
export const LINK_PRESETS: Readonly<Record<string, Partial<LinkSettings>>> = {
  "3g": { down: 50_000, up: 50_000, delay: 200 },
};

/**
 * The settings named by `read`, a lookup of option names (`preset`, `down`, `up`, `delay`,
 * `jitter`, `freeze`, `new-connections`): the preset first, then each explicit option over it.
 */
export function parseLink(
  read: (name: string) => string | null | undefined,
): Partial<LinkSettings> {
  const preset = read("preset");
  if (preset != null && LINK_PRESETS[preset] === undefined) {
    throw new Error(
      `unknown link preset ${preset}; known: ${Object.keys(LINK_PRESETS).join(", ")}`,
    );
  }
  const number = (name: string) => {
    const value = read(name);
    return value == null ? {} : { [name]: Number(value) };
  };
  const freeze = read("freeze");
  const newConnections = read("new-connections");
  return {
    ...(preset == null ? {} : LINK_PRESETS[preset]),
    ...number("down"),
    ...number("up"),
    ...number("delay"),
    ...number("jitter"),
    ...(freeze == null ? {} : { frozen: freeze === "1" }),
    ...(newConnections == null ? {} : { newConnections: newConnections === "1" }),
  };
}

const QUEUE_HIGH_WATER_BYTES = 64 * 1024;
/** Extra room while bytes wait out a delay, so latency alone does not cap an unlimited link. */
const DELAY_WINDOW_BYTES = 8 * 1024 * 1024;
const PIECE_BYTES = 4 * 1024;
const FROZEN_POLL_MS = 20;

export interface ThrottleProxy {
  readonly port: number;
  readonly settings: () => LinkSettings;
  readonly update: (next: Partial<LinkSettings>) => LinkSettings;
  /** Destroys every open connection, as a dropped link would; new ones still connect. */
  readonly drop: () => void;
  readonly close: () => Promise<void>;
}

const MAX_RESPONSE_HEAD_BYTES = 16 * 1024;

/**
 * Rewrites the head of the first HTTP response on a connection to say `Connection: close`, so
 * the client opens a new connection for its next request. Anything that is not a plain response
 * (a 101 upgrade, other bytes) passes through unchanged.
 * shortcut: a response head cut short by the connection ending is dropped, not flushed; fine for
 * a development proxy whose servers answer in one write.
 */
function closeAfterFirstResponse(): (data: Buffer) => Buffer {
  let held: Buffer | undefined = Buffer.alloc(0);
  return (data) => {
    if (held === undefined) return data;
    held = Buffer.concat([held, data]);
    const end = held.indexOf("\r\n\r\n");
    if (end < 0 && held.length <= MAX_RESPONSE_HEAD_BYTES) return Buffer.alloc(0);
    const bytes = held;
    held = undefined;
    if (end < 0) return bytes;
    const [status = "", ...fields] = bytes.subarray(0, end).toString("latin1").split("\r\n");
    if (!/^HTTP\/1\.[01] /.test(status) || status.split(" ")[1] === "101") return bytes;
    const head = [
      status,
      ...fields.filter((field) => !/^connection:/i.test(field)),
      "Connection: close",
    ];
    return Buffer.concat([Buffer.from(head.join("\r\n"), "latin1"), bytes.subarray(end)]);
  };
}

/** Forwards `source` to `destination` at `rate()` bytes per second; returns a stop function. */
function pace(
  source: NodeNet.Socket,
  destination: NodeNet.Socket,
  rate: () => number,
  frozen: () => boolean,
  latency: () => number,
  rewrite: (data: Buffer) => Buffer = (data) => data,
): () => void {
  const queue: Array<{ readonly piece: Buffer; readonly readyAt: number }> = [];
  let queued = 0;
  let nextSendAt = 0;
  let lastReadyAt = 0;
  // ponytail: a fixed allowance for bytes in flight; size it from rate x delay if a
  // measurement ever needs more than 8 MiB in flight.
  const highWater = () => QUEUE_HIGH_WATER_BYTES + (latency() > 0 ? DELAY_WINDOW_BYTES : 0);
  let ended = false;
  let waitingForDrain = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (delayMs: number): void => {
    if (timer === null && !waitingForDrain) timer = setTimeout(pump, Math.max(0, delayMs));
  };

  function pump(): void {
    timer = null;
    if (frozen()) {
      schedule(FROZEN_POLL_MS);
      return;
    }
    const head = queue[0];
    if (head === undefined) {
      if (ended) destination.end();
      return;
    }
    if (head.readyAt > Date.now()) {
      schedule(head.readyAt - Date.now());
      return;
    }
    queue.shift();
    const piece = head.piece;
    queued -= piece.length;
    if (queued < highWater() && source.isPaused()) source.resume();
    const bytesPerSecond = rate();
    const now = Date.now();
    nextSendAt =
      bytesPerSecond > 0 ? Math.max(now, nextSendAt) + (piece.length / bytesPerSecond) * 1000 : now;
    if (!destination.write(piece)) {
      waitingForDrain = true;
      destination.once("drain", () => {
        waitingForDrain = false;
        schedule(nextSendAt - Date.now());
      });
      return;
    }
    schedule(nextSendAt - Date.now());
  }

  source.on("data", (chunk: Buffer) => {
    const data = rewrite(chunk);
    if (data.length === 0) return;
    // Later bytes never overtake earlier ones, whatever the jitter.
    const readyAt = Math.max(lastReadyAt, Date.now() + latency());
    lastReadyAt = readyAt;
    for (let offset = 0; offset < data.length; offset += PIECE_BYTES) {
      const piece = data.subarray(offset, offset + PIECE_BYTES);
      queue.push({ piece, readyAt });
      queued += piece.length;
    }
    if (queued >= highWater()) source.pause();
    schedule(nextSendAt - Date.now());
  });
  source.on("end", () => {
    ended = true;
    schedule(0);
  });
  return () => {
    if (timer !== null) clearTimeout(timer);
  };
}

export async function startThrottleProxy(options: {
  readonly listenHost: string;
  readonly listenPort: number;
  readonly targetHost: string;
  readonly targetPort: number;
  readonly initial?: Partial<LinkSettings>;
}): Promise<ThrottleProxy> {
  let settings: LinkSettings = { ...UNTHROTTLED, ...options.initial };
  const sockets = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer((client) => {
    const upstream = NodeNet.connect(options.targetPort, options.targetHost);
    sockets.add(client);
    sockets.add(upstream);
    const latency = () => settings.delay + Math.random() * settings.jitter;
    const newConnections = settings.newConnections === true;
    // The handshake is one round trip before the client's first byte can leave.
    let handshaking = newConnections;
    const stopDown = pace(
      upstream,
      client,
      () => settings.down,
      () => settings.frozen,
      latency,
      newConnections ? closeAfterFirstResponse() : undefined,
    );
    const stopUp = pace(
      client,
      upstream,
      () => settings.up,
      () => settings.frozen,
      () => {
        const handshake = handshaking ? 2 * settings.delay : 0;
        handshaking = false;
        return latency() + handshake;
      },
    );
    const destroyBoth = (): void => {
      stopDown();
      stopUp();
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("error", destroyBoth);
    upstream.on("error", destroyBoth);
    client.on("close", destroyBoth);
    // When the server closes, the paced queue still drains to the client before it ends.
    upstream.on("close", () => sockets.delete(upstream));
  });
  await new Promise<void>((resolve) =>
    server.listen(options.listenPort, options.listenHost, resolve),
  );
  const address = server.address() as NodeNet.AddressInfo;
  return {
    port: address.port,
    settings: () => settings,
    update: (next) => {
      settings = { ...settings, ...next };
      return settings;
    },
    drop: () => {
      for (const socket of sockets) socket.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

export function startControlServer(
  proxy: ThrottleProxy,
  host: string,
  port: number,
): Promise<NodeHttp.Server> {
  const server = NodeHttp.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://control.invalid");
    if (url.pathname === "/drop") proxy.drop();
    if (url.pathname === "/set") {
      try {
        proxy.update(parseLink((name) => url.searchParams.get(name)));
      } catch (error) {
        response.writeHead(400, { "content-type": "text/plain" });
        response.end(String(error));
        return;
      }
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(proxy.settings()));
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

function parseAddress(
  value: string | undefined,
  fallback: string,
): {
  readonly host: string;
  readonly port: number;
} {
  const [host = "127.0.0.1", port = "0"] = (value ?? fallback).split(":");
  return { host, port: Number(port) };
}

export async function runThrottleProxyMain(
  isMain: boolean,
  argv: ReadonlyArray<string> = process.argv.slice(2),
): Promise<boolean> {
  if (!isMain) return false;
  const args = new Map<string, string>();
  for (let index = 0; index + 1 < argv.length; index += 2) {
    args.set(argv[index]!, argv[index + 1]!);
  }
  const listen = parseAddress(args.get("--listen"), "127.0.0.1:13854");
  const target = parseAddress(args.get("--target"), "127.0.0.1:13853");
  const control = parseAddress(args.get("--control"), "127.0.0.1:13855");
  const proxy = await startThrottleProxy({
    listenHost: listen.host,
    listenPort: listen.port,
    targetHost: target.host,
    targetPort: target.port,
    initial: parseLink((name) => args.get(`--${name}`)),
  });
  const controlServer = await startControlServer(proxy, control.host, control.port);
  const controlPort = (controlServer.address() as NodeNet.AddressInfo).port;
  console.log(
    `throttle proxy ${listen.host}:${proxy.port} -> ${target.host}:${target.port}; control http://${control.host}:${controlPort}`,
  );
  return true;
}

void runThrottleProxyMain(import.meta.main);
