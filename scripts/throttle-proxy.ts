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
 * GET /measurements is a separate read-only, payload-free accounting snapshot.
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

export type PaceObservation =
  | { readonly _tag: "received" | "accepted" | "discarded"; readonly bytes: number }
  | {
      readonly _tag:
        | "write"
        | "backpressure"
        | "drain"
        | "drain-abandoned"
        | "started"
        | "stopped"
        | "invalid";
    };

export interface DirectionMeasurements {
  readonly complete: boolean;
  readonly overflow: boolean;
  readonly receivedBytes: number;
  readonly destinationAcceptedBytes: number;
  readonly queuedBytes: number | null;
  readonly peakQueuedBytes: number;
  readonly discardedBytes: number;
  readonly writeCalls: number;
  readonly backpressureEvents: number;
  readonly drainEvents: number;
  readonly abandonedDrainWaits: number;
  readonly activeDirections: number;
  readonly stoppedDirections: number;
}
export interface ProxyMeasurements {
  readonly version: 1;
  readonly complete: boolean;
  readonly overflow: boolean;
  readonly connections: {
    readonly created: number;
    readonly active: number;
    readonly closed: number;
  };
  readonly up: DirectionMeasurements;
  readonly down: DirectionMeasurements;
  readonly total: DirectionMeasurements;
  readonly controls: { readonly nativeWebSocket: "not-observed"; readonly rpc: "not-observed" };
}

/** Constant-space metadata accumulator. No connection IDs, errors or byte buffers are retained. */
export function createProxyMeasurements() {
  const makeDirection = () => ({
    complete: true,
    overflow: false,
    receivedBytes: 0,
    destinationAcceptedBytes: 0,
    queuedBytes: 0 as number | null,
    peakQueuedBytes: 0,
    discardedBytes: 0,
    writeCalls: 0,
    backpressureEvents: 0,
    drainEvents: 0,
    abandonedDrainWaits: 0,
    activeDirections: 0,
    stoppedDirections: 0,
  });
  const up = makeDirection(),
    down = makeDirection(),
    total = makeDirection();
  const connections = { created: 0, active: 0, closed: 0 };
  let connectionOverflow = false;
  type Direction = ReturnType<typeof makeDirection>;
  const add = (
    direction: Direction,
    key: Exclude<keyof Direction, "complete" | "overflow" | "queuedBytes">,
    amount: number,
  ) => {
    const value = direction[key] + amount;
    if (!Number.isSafeInteger(value) || value < 0) {
      direction.complete = false;
      direction.overflow = true;
      direction[key] = Number.MAX_SAFE_INTEGER;
    } else direction[key] = value;
  };
  const queue = (direction: Direction, amount: number) => {
    if (direction.queuedBytes === null) return;
    const value = direction.queuedBytes + amount;
    if (!Number.isSafeInteger(value) || value < 0) {
      direction.queuedBytes = null;
      direction.complete = false;
      direction.overflow = true;
    } else {
      direction.queuedBytes = value;
      direction.peakQueuedBytes = Math.max(direction.peakQueuedBytes, value);
    }
  };
  const record = (direction: Direction, event: PaceObservation) => {
    if (event._tag === "received" || event._tag === "accepted" || event._tag === "discarded") {
      if (!Number.isSafeInteger(event.bytes) || event.bytes < 0) {
        direction.complete = false;
        direction.queuedBytes = null;
        return;
      }
      const key =
        event._tag === "received"
          ? "receivedBytes"
          : event._tag === "accepted"
            ? "destinationAcceptedBytes"
            : "discardedBytes";
      add(direction, key, event.bytes);
      queue(direction, event._tag === "received" ? event.bytes : -event.bytes);
      return;
    }
    switch (event._tag) {
      case "write":
        add(direction, "writeCalls", 1);
        break;
      case "backpressure":
        add(direction, "backpressureEvents", 1);
        break;
      case "drain":
        add(direction, "drainEvents", 1);
        break;
      case "drain-abandoned":
        add(direction, "abandonedDrainWaits", 1);
        break;
      case "started":
        add(direction, "activeDirections", 1);
        break;
      case "stopped":
        add(direction, "activeDirections", -1);
        add(direction, "stoppedDirections", 1);
        break;
      default:
        direction.complete = false;
    }
  };
  const connection = (opened: boolean) => {
    for (const [key, amount] of opened
      ? ([
          ["created", 1],
          ["active", 1],
        ] as const)
      : ([
          ["active", -1],
          ["closed", 1],
        ] as const)) {
      const value = connections[key] + amount;
      if (!Number.isSafeInteger(value) || value < 0) connectionOverflow = true;
      else connections[key] = value;
    }
  };
  return {
    observe: (direction: "up" | "down", event: PaceObservation) => {
      record(direction === "up" ? up : down, event);
      record(total, event);
    },
    connected: () => connection(true),
    disconnected: () => connection(false),
    snapshot: (): ProxyMeasurements => ({
      version: 1,
      complete: up.complete && down.complete && total.complete && !connectionOverflow,
      overflow: up.overflow || down.overflow || total.overflow || connectionOverflow,
      connections: { ...connections },
      up: { ...up },
      down: { ...down },
      total: { ...total },
      controls: { nativeWebSocket: "not-observed", rpc: "not-observed" },
    }),
  };
}

export interface ThrottleProxy {
  readonly port: number;
  readonly settings: () => LinkSettings;
  readonly update: (next: Partial<LinkSettings>) => LinkSettings;
  readonly measurements: () => ProxyMeasurements;
  readonly close: () => Promise<void>;
}

/** Existing paced direction owns its queue, callbacks and metadata until stop or EOF. */
export function pace(
  source: NodeNet.Socket,
  destination: NodeNet.Socket,
  rate: () => number,
  frozen: () => boolean,
  observe: (event: PaceObservation) => void = () => {},
): () => void {
  const queue: Array<Buffer> = [];
  let queued = 0;
  let nextSendAt = 0;
  let ended = false;
  let stopped = false;
  let waitingForDrain = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  observe({ _tag: "started" });

  const schedule = (delayMs: number): void => {
    if (!stopped && timer === null && !waitingForDrain)
      timer = setTimeout(pump, Math.max(0, delayMs));
  };
  const onDrain = (): void => {
    if (stopped) return;
    waitingForDrain = false;
    observe({ _tag: "drain" });
    schedule(nextSendAt - Date.now());
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    source.off("data", onData);
    source.off("end", onEnd);
    destination.off("drain", onDrain);
    destination.off("close", stop);
    if (waitingForDrain) {
      waitingForDrain = false;
      observe({ _tag: "drain-abandoned" });
    }
    observe({ _tag: "discarded", bytes: queued });
    queued = 0;
    queue.length = 0;
    observe({ _tag: "stopped" });
  };
  function pump(): void {
    timer = null;
    if (stopped) return;
    if (frozen()) {
      schedule(FROZEN_POLL_MS);
      return;
    }
    const piece = queue.shift();
    if (piece === undefined) {
      if (ended) {
        destination.end();
        stop();
      }
      return;
    }
    queued -= piece.length;
    if (queued < QUEUE_HIGH_WATER_BYTES && source.isPaused()) source.resume();
    const bytesPerSecond = rate();
    const now = Date.now();
    nextSendAt =
      bytesPerSecond > 0 ? Math.max(now, nextSendAt) + (piece.length / bytesPerSecond) * 1000 : now;
    observe({ _tag: "write" });
    let accepted: boolean;
    try {
      accepted = destination.write(piece);
    } catch (error) {
      observe({ _tag: "invalid" });
      observe({ _tag: "discarded", bytes: piece.length });
      stop();
      throw error;
    }
    observe({ _tag: "accepted", bytes: piece.length });
    if (!accepted) {
      observe({ _tag: "backpressure" });
      if (!stopped) {
        waitingForDrain = true;
        destination.once("drain", onDrain);
      }
      return;
    }
    schedule(nextSendAt - Date.now());
  }
  function onData(data: Buffer): void {
    if (stopped) return;
    observe({ _tag: "received", bytes: data.length });
    for (let offset = 0; offset < data.length; offset += PIECE_BYTES) {
      const piece = data.subarray(offset, offset + PIECE_BYTES);
      queue.push(piece);
      queued += piece.length;
    }
    if (queued >= QUEUE_HIGH_WATER_BYTES) source.pause();
    schedule(nextSendAt - Date.now());
  }
  function onEnd(): void {
    if (stopped) return;
    ended = true;
    schedule(0);
  }
  source.on("data", onData);
  source.on("end", onEnd);
  destination.on("close", stop);
  return stop;
}

export async function startThrottleProxy(options: {
  readonly listenHost: string;
  readonly listenPort: number;
  readonly targetHost: string;
  readonly targetPort: number;
  readonly initial?: Partial<LinkSettings>;
}): Promise<ThrottleProxy> {
  let settings: LinkSettings = { ...UNTHROTTLED, ...options.initial };
  const measurements = createProxyMeasurements();
  const connections = new Set<{ stop: () => void; done: Promise<void> }>();
  let closing: Promise<void> | null = null;
  const server = NodeNet.createServer((client) => {
    const upstream = NodeNet.connect(options.targetPort, options.targetHost);
    measurements.connected();
    const stopDown = pace(
      upstream,
      client,
      () => settings.down,
      () => settings.frozen,
      (event) => measurements.observe("down", event),
    );
    const stopUp = pace(
      client,
      upstream,
      () => settings.up,
      () => settings.frozen,
      (event) => measurements.observe("up", event),
    );
    let stopped = false,
      clientClosed = false,
      upstreamClosed = false;
    let resolveClosed: () => void;
    const done = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const destroyBoth = (): void => {
      if (stopped) return;
      stopped = true;
      stopDown();
      stopUp();
      client.destroy();
      upstream.destroy();
    };
    const owner = { stop: destroyBoth, done };
    connections.add(owner);
    const finish = () => {
      if (!clientClosed || !upstreamClosed) return;
      connections.delete(owner);
      measurements.disconnected();
      resolveClosed();
    };
    client.on("error", destroyBoth);
    upstream.on("error", destroyBoth);
    client.once("close", () => {
      clientClosed = true;
      destroyBoth();
      finish();
    });
    // Server EOF still drains the paced downstream queue before ending the client.
    upstream.once("close", () => {
      upstreamClosed = true;
      finish();
    });
    if (closing !== null) destroyBoth();
  });
  await new Promise<void>((resolve) =>
    server.listen(options.listenPort, options.listenHost, resolve),
  );
  const address = server.address() as NodeNet.AddressInfo;
  return {
    port: address.port,
    settings: () => settings,
    measurements: () => measurements.snapshot(),
    update: (next) => {
      settings = { ...settings, ...next };
      return settings;
    },
    close: () => {
      closing ??= (async () => {
        const serverClosed = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        for (const owner of connections) owner.stop();
        await serverClosed;
        await Promise.all([...connections].map((owner) => owner.done));
      })();
      return closing;
    },
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
    response.end(
      JSON.stringify(url.pathname === "/measurements" ? proxy.measurements() : proxy.settings()),
    );
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
