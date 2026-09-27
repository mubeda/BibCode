// @effect-diagnostics nodeBuiltinImport:off - A development TCP proxy works on raw sockets.
// @effect-diagnostics globalTimers:off - Pacing owns short, bounded timers.
// @effect-diagnostics globalDate:off - Pacing schedules each piece against wall-clock send times.
// @effect-diagnostics globalConsole:off - The CLI prints its bound addresses for the operator.
/**
 * Throttling TCP proxy for the slow-link liveness runbook
 * (docs/testing/cross-platform-validation.md, "Slow-link liveness scenario").
 * It is a development tool and never runs in production.
 *
 * Each direction is paced at its own rate. The proxy stops reading a source
 * while that direction holds 64 KiB, so a slow link makes the sender's socket
 * writes block (backpressure). `frozen` stops both directions without closing
 * either socket.
 *
 *   node scripts/throttle-proxy.ts --listen 127.0.0.1:13854 --target 127.0.0.1:13853 \
 *     --control 127.0.0.1:13855 [--down <bytes/s>] [--up <bytes/s>]
 *
 * Control API: GET /set?down=<B/s>&up=<B/s>&freeze=0|1 (0 B/s is unlimited); GET /state.
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
}

export const UNTHROTTLED: LinkSettings = { down: 0, up: 0, frozen: false };

const QUEUE_HIGH_WATER_BYTES = 64 * 1024;
const PIECE_BYTES = 4 * 1024;
const FROZEN_POLL_MS = 20;

export interface ThrottleProxy {
  readonly port: number;
  readonly settings: () => LinkSettings;
  readonly update: (next: Partial<LinkSettings>) => LinkSettings;
  readonly close: () => Promise<void>;
}

/** Forwards `source` to `destination` at `rate()` bytes per second; returns a stop function. */
function pace(
  source: NodeNet.Socket,
  destination: NodeNet.Socket,
  rate: () => number,
  frozen: () => boolean,
): () => void {
  const queue: Array<Buffer> = [];
  let queued = 0;
  let nextSendAt = 0;
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
    const piece = queue.shift();
    if (piece === undefined) {
      if (ended) destination.end();
      return;
    }
    queued -= piece.length;
    if (queued < QUEUE_HIGH_WATER_BYTES && source.isPaused()) source.resume();
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

  source.on("data", (data: Buffer) => {
    for (let offset = 0; offset < data.length; offset += PIECE_BYTES) {
      const piece = data.subarray(offset, offset + PIECE_BYTES);
      queue.push(piece);
      queued += piece.length;
    }
    if (queued >= QUEUE_HIGH_WATER_BYTES) source.pause();
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
    const stopDown = pace(
      upstream,
      client,
      () => settings.down,
      () => settings.frozen,
    );
    const stopUp = pace(
      client,
      upstream,
      () => settings.up,
      () => settings.frozen,
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
    if (url.pathname === "/set") {
      const down = url.searchParams.get("down");
      const up = url.searchParams.get("up");
      const freeze = url.searchParams.get("freeze");
      proxy.update({
        ...(down === null ? {} : { down: Number(down) }),
        ...(up === null ? {} : { up: Number(up) }),
        ...(freeze === null ? {} : { frozen: freeze === "1" }),
      });
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
    initial: { down: Number(args.get("--down") ?? 0), up: Number(args.get("--up") ?? 0) },
  });
  const controlServer = await startControlServer(proxy, control.host, control.port);
  const controlPort = (controlServer.address() as NodeNet.AddressInfo).port;
  console.log(
    `throttle proxy ${listen.host}:${proxy.port} -> ${target.host}:${target.port}; control http://${control.host}:${controlPort}`,
  );
  return true;
}

void runThrottleProxyMain(import.meta.main);
