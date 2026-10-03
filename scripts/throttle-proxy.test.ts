// @effect-diagnostics nodeBuiltinImport:off - The proxy test drives raw loopback sockets.
// @effect-diagnostics globalTimers:off - The freeze check waits a bounded real time.
// @effect-diagnostics globalDate:off - The pacing check measures elapsed wall-clock time.
// @effect-diagnostics globalFetch:off - The test drives the proxy's loopback control API.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeNet from "node:net";
import * as NodeURL from "node:url";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  startThrottleProxy,
  startControlServer,
  runThrottleProxyMain,
  pace,
  createProxyMeasurements,
} from "./throttle-proxy.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function servePayload(payload: Buffer): Promise<number> {
  const server = NodeNet.createServer((socket) => socket.end(payload));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as NodeNet.AddressInfo).port;
}

function readAll(port: number, onData?: (total: number) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Array<Buffer> = [];
    let total = 0;
    const socket = NodeNet.connect(port, "127.0.0.1");
    socket.on("data", (data: Buffer) => {
      parts.push(data);
      total += data.length;
      onData?.(total);
    });
    socket.on("end", () => resolve(Buffer.concat(parts)));
    socket.on("error", reject);
  });
}

describe("startThrottleProxy", () => {
  it("paces server-to-client bytes at the configured rate", async () => {
    const payload = Buffer.alloc(64 * 1024, 120);
    const target = await servePayload(payload);
    const proxy = await startThrottleProxy({
      listenHost: "127.0.0.1",
      listenPort: 0,
      targetHost: "127.0.0.1",
      targetPort: target,
      initial: { down: 128 * 1024 },
    });
    cleanups.push(proxy.close);
    const started = Date.now();
    const received = await readAll(proxy.port);
    const elapsed = Date.now() - started;
    expect(received).toEqual(payload);
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(3000);
  });

  it("forwards nothing while frozen and everything once thawed", async () => {
    const payload = Buffer.alloc(16 * 1024, 121);
    const target = await servePayload(payload);
    const proxy = await startThrottleProxy({
      listenHost: "127.0.0.1",
      listenPort: 0,
      targetHost: "127.0.0.1",
      targetPort: target,
      initial: { frozen: true },
    });
    cleanups.push(proxy.close);
    let receivedWhileFrozen = 0;
    const reading = readAll(proxy.port, (total) => {
      if (proxy.settings().frozen) receivedWhileFrozen = total;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(receivedWhileFrozen).toBe(0);
    proxy.update({ frozen: false });
    expect(await reading).toEqual(payload);
  });

  it("changes rates, freezes and thaws through the HTTP control API", async () => {
    const payload = Buffer.alloc(8192, 122);
    const targetPort = await servePayload(payload);
    const proxy = await startThrottleProxy({
      listenHost: "127.0.0.1",
      listenPort: 0,
      targetHost: "127.0.0.1",
      targetPort,
    });
    cleanups.push(proxy.close);
    const control = await startControlServer(proxy, "127.0.0.1", 0);
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          control.closeAllConnections();
          control.close(() => resolve());
        }),
    );
    const port = (control.address() as NodeNet.AddressInfo).port;
    const get = async (path: string) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await get("/set?down=65536&up=32768")).toEqual({
      down: 65536,
      up: 32768,
      frozen: false,
    });
    expect(await get("/set?freeze=1")).toEqual({
      down: 65536,
      up: 32768,
      frozen: true,
    });
    let bytes = 0;
    const reading = readAll(proxy.port, (total) => {
      bytes = total;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bytes).toBe(0);
    expect(await get("/set?freeze=0")).toEqual({
      down: 65536,
      up: 32768,
      frozen: false,
    });
    expect(await reading).toEqual(payload);
    expect(await get("/set?down=0")).toEqual({ down: 0, up: 32768, frozen: false });
    expect(await get("/state")).toEqual({ down: 0, up: 32768, frozen: false });
  });

  it("uses CLI listen/target/control and rate arguments", async () => {
    const payload = Buffer.from("CLI target reached");
    const target = await servePayload(payload);
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        NodeURL.fileURLToPath(new URL("./throttle-proxy.ts", import.meta.url)),
        "--listen",
        "127.0.0.1:0",
        "--target",
        `127.0.0.1:${target}`,
        "--control",
        "127.0.0.1:0",
        "--down",
        "65536",
        "--up",
        "32768",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    cleanups.push(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const stopped = NodeEvents.once(child, "exit");
      child.kill();
      await stopped;
    });
    let output = "";
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });
    await vi.waitFor(() => expect(output).toMatch(/control http:\/\/127\.0\.0\.1:\d+/));
    const ports = output.match(
      /throttle proxy 127\.0\.0\.1:(\d+).*control http:\/\/127\.0\.0\.1:(\d+)/,
    );
    expect(ports).not.toBeNull();
    const listenPort = Number(ports![1]);
    const controlPort = Number(ports![2]);
    expect(controlPort).toBeGreaterThan(0);
    expect(await (await fetch(`http://127.0.0.1:${controlPort}/state`)).json()).toEqual({
      down: 65536,
      up: 32768,
      frozen: false,
    });
    expect(await readAll(listenPort)).toEqual(payload);
  });

  it("does not start a CLI server when imported", async () => {
    expect(await runThrottleProxyMain(false, [])).toBe(false);
  });
});

it("counts actual forwarded duplex bytes without changing their contents or control settings", async () => {
  const upstreamBytes = Buffer.from("owned-upstream-sentinel");
  const downstreamBytes = Buffer.from("owned-downstream-sentinel");
  const received: Buffer[] = [];
  const server = NodeNet.createServer((socket) => {
    socket.on("data", (chunk: Buffer) => {
      received.push(chunk);
      if (Buffer.concat(received).length === upstreamBytes.length) socket.end(downstreamBytes);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const proxy = await startThrottleProxy({
    listenHost: "127.0.0.1",
    listenPort: 0,
    targetHost: "127.0.0.1",
    targetPort: (server.address() as NodeNet.AddressInfo).port,
  });
  cleanups.push(proxy.close);
  const response = await new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = [];
    const client = NodeNet.connect(proxy.port, "127.0.0.1", () => client.write(upstreamBytes));
    client.on("data", (piece: Buffer) => parts.push(piece));
    client.on("end", () => resolve(Buffer.concat(parts)));
    client.on("error", reject);
  });
  expect(response).toEqual(downstreamBytes);
  expect(Buffer.concat(received)).toEqual(upstreamBytes);
  await proxy.close();
  const measured = proxy.measurements();
  expect(measured.up).toMatchObject({
    receivedBytes: upstreamBytes.length,
    destinationAcceptedBytes: upstreamBytes.length,
    queuedBytes: 0,
    discardedBytes: 0,
    complete: true,
  });
  expect(measured.down).toMatchObject({
    receivedBytes: downstreamBytes.length,
    destinationAcceptedBytes: downstreamBytes.length,
    queuedBytes: 0,
    discardedBytes: 0,
    complete: true,
  });
  expect(measured.connections).toEqual({ created: 1, active: 0, closed: 1 });
  expect(measured.controls).toEqual({ nativeWebSocket: "not-observed", rpc: "not-observed" });
  expect(JSON.stringify(measured)).not.toMatch(/sentinel|127\.0\.0\.1|port|path|payload/);
});

it("reports frozen queued/discarded bytes and joins closure without later counter movement", async () => {
  const target = await servePayload(Buffer.alloc(16 * 1024, 120));
  const proxy = await startThrottleProxy({
    listenHost: "127.0.0.1",
    listenPort: 0,
    targetHost: "127.0.0.1",
    targetPort: target,
    initial: { frozen: true },
  });
  cleanups.push(proxy.close);
  const client = NodeNet.connect(proxy.port, "127.0.0.1");
  client.on("error", () => {});
  cleanups.push(async () => {
    client.destroy();
  });
  await vi.waitFor(() => expect(proxy.measurements().down.queuedBytes).toBe(16 * 1024));
  expect(proxy.measurements().down).toMatchObject({
    destinationAcceptedBytes: 0,
    peakQueuedBytes: 16 * 1024,
  });
  await proxy.close();
  const terminal = proxy.measurements();
  expect(terminal.down).toMatchObject({
    receivedBytes: 16 * 1024,
    queuedBytes: 0,
    discardedBytes: 16 * 1024,
  });
  expect(terminal.connections.active).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(proxy.measurements()).toEqual(terminal);
});

it("fences stopped direction data/drain callbacks and discards only its unaccepted queue", () => {
  vi.useFakeTimers();
  const source = new NodeNet.Socket();
  const destination = new NodeNet.Socket();
  const measurements = createProxyMeasurements();
  const write = vi.spyOn(destination, "write").mockReturnValue(false);
  try {
    const stop = pace(
      source,
      destination,
      () => 0,
      () => false,
      (event) => measurements.observe("up", event),
    );
    source.emit("data", Buffer.alloc(8192));
    vi.advanceTimersByTime(0);
    expect(write).toHaveBeenCalledTimes(1);
    const lateData = source.listeners("data").at(-1)!;
    const lateDrain = destination.listeners("drain").at(-1)!;
    stop();
    const terminal = measurements.snapshot();
    expect(terminal.up).toMatchObject({
      receivedBytes: 8192,
      destinationAcceptedBytes: 4096,
      discardedBytes: 4096,
      queuedBytes: 0,
      backpressureEvents: 1,
      drainEvents: 0,
      abandonedDrainWaits: 1,
    });
    lateData(Buffer.alloc(4096));
    lateDrain();
    destination.emit("drain");
    vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(measurements.snapshot()).toEqual(terminal);
    expect(source.listenerCount("data")).toBe(0);
    expect(destination.listenerCount("drain")).toBe(0);
  } finally {
    source.destroy();
    destination.destroy();
    vi.useRealTimers();
  }
});

it("observes backpressure drain and exact writes before normal end without changing the byte sequence", () => {
  vi.useFakeTimers();
  const source = new NodeNet.Socket();
  const destination = new NodeNet.Socket();
  const measurements = createProxyMeasurements();
  const writes: Buffer[] = [];
  vi.spyOn(destination, "write").mockImplementation((piece) => {
    writes.push(Buffer.from(piece as Buffer));
    return writes.length !== 1;
  });
  const end = vi.spyOn(destination, "end").mockReturnValue(destination);
  try {
    const stop = pace(
      source,
      destination,
      () => 0,
      () => false,
      (event) => measurements.observe("down", event),
    );
    const bytes = Buffer.alloc(8192, 121);
    source.emit("data", bytes);
    source.emit("end");
    vi.advanceTimersByTime(0);
    expect(measurements.snapshot().down).toMatchObject({
      queuedBytes: 4096,
      destinationAcceptedBytes: 4096,
      backpressureEvents: 1,
      drainEvents: 0,
    });
    destination.emit("drain");
    vi.advanceTimersByTime(1);
    expect(Buffer.concat(writes)).toEqual(bytes);
    expect(end).toHaveBeenCalledOnce();
    expect(measurements.snapshot().down).toMatchObject({
      queuedBytes: 0,
      destinationAcceptedBytes: 8192,
      writeCalls: 2,
      drainEvents: 1,
      discardedBytes: 0,
    });
    stop();
  } finally {
    source.destroy();
    destination.destroy();
    vi.useRealTimers();
  }
});

it("keeps counter overflow or malformed numbers explicit without retaining foreign metadata", () => {
  const measurements = createProxyMeasurements();
  measurements.observe("up", { _tag: "received", bytes: Number.MAX_SAFE_INTEGER });
  measurements.observe("up", { _tag: "received", bytes: 1 });
  expect(measurements.snapshot().up).toMatchObject({ complete: false, overflow: true });
  expect(measurements.snapshot().up.queuedBytes).toBeNull();
  const malformed = createProxyMeasurements();
  malformed.observe("down", { _tag: "received", bytes: NaN, secret: "do-not-retain" } as never);
  expect(malformed.snapshot().down.complete).toBe(false);
  expect(JSON.stringify(malformed.snapshot())).not.toContain("do-not-retain");
});

it("reports the actual overshoot callback and simultaneous aggregate queue peak", () => {
  vi.useFakeTimers();
  const source = new NodeNet.Socket();
  const destination = new NodeNet.Socket();
  const measurements = createProxyMeasurements();
  try {
    const stop = pace(
      source,
      destination,
      () => 0,
      () => true,
      (event) => measurements.observe("up", event),
    );
    source.emit("data", Buffer.alloc(128 * 1024));
    measurements.observe("down", { _tag: "received", bytes: 4096 });
    expect(source.isPaused()).toBe(true);
    expect(measurements.snapshot().up.peakQueuedBytes).toBe(128 * 1024);
    expect(measurements.snapshot().total.peakQueuedBytes).toBe(128 * 1024 + 4096);
    stop();
    measurements.observe("down", { _tag: "discarded", bytes: 4096 });
    expect(measurements.snapshot().total.queuedBytes).toBe(0);
  } finally {
    source.destroy();
    destination.destroy();
    vi.useRealTimers();
  }
});

it("stops a direction whose destination closes and cannot restart a queued freeze timer", () => {
  vi.useFakeTimers();
  const source = new NodeNet.Socket();
  const destination = new NodeNet.Socket();
  const measurements = createProxyMeasurements();
  const write = vi.spyOn(destination, "write").mockReturnValue(true);
  try {
    const stop = pace(
      source,
      destination,
      () => 0,
      () => true,
      (event) => measurements.observe("down", event),
    );
    source.emit("data", Buffer.alloc(4096));
    vi.advanceTimersByTime(0);
    destination.emit("close");
    const terminal = measurements.snapshot();
    expect(terminal.down).toMatchObject({
      queuedBytes: 0,
      discardedBytes: 4096,
      stoppedDirections: 1,
    });
    vi.advanceTimersByTime(1000);
    expect(write).not.toHaveBeenCalled();
    expect(measurements.snapshot()).toEqual(terminal);
    stop();
  } finally {
    source.destroy();
    destination.destroy();
    vi.useRealTimers();
  }
});

it("preserves a native write throw while reporting unknown admission and cleaning the owned queue", () => {
  vi.useFakeTimers();
  const source = new NodeNet.Socket();
  const destination = new NodeNet.Socket();
  const measurements = createProxyMeasurements();
  const failure = new Error("private-native-write");
  vi.spyOn(destination, "write").mockImplementation(() => {
    throw failure;
  });
  try {
    pace(
      source,
      destination,
      () => 0,
      () => false,
      (event) => measurements.observe("up", event),
    );
    source.emit("data", Buffer.alloc(8192));
    expect(() => vi.advanceTimersByTime(0)).toThrow(failure);
    expect(measurements.snapshot().up).toMatchObject({
      complete: false,
      receivedBytes: 8192,
      destinationAcceptedBytes: 0,
      discardedBytes: 8192,
      queuedBytes: 0,
      writeCalls: 1,
      stoppedDirections: 1,
    });
    expect(JSON.stringify(measurements.snapshot())).not.toContain("private");
  } finally {
    source.destroy();
    destination.destroy();
    vi.useRealTimers();
  }
});

it("exposes only metadata on the new read-only route and keeps existing state/set responses exact", async () => {
  const target = await servePayload(Buffer.alloc(0));
  const proxy = await startThrottleProxy({
    listenHost: "127.0.0.1",
    listenPort: 0,
    targetHost: "127.0.0.1",
    targetPort: target,
  });
  cleanups.push(proxy.close);
  const server = await startControlServer(proxy, "127.0.0.1", 0);
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const port = (server.address() as NodeNet.AddressInfo).port;
  const before = proxy.settings();
  const measured = await (
    await fetch(`http://127.0.0.1:${port}/measurements?up=1&freeze=1`)
  ).json();
  expect(measured).toEqual(proxy.measurements());
  expect(proxy.settings()).toEqual(before);
  expect(await (await fetch(`http://127.0.0.1:${port}/state`)).json()).toEqual({
    down: 0,
    up: 0,
    frozen: false,
  });
  expect(await (await fetch(`http://127.0.0.1:${port}/set?up=65536`)).json()).toEqual({
    down: 0,
    up: 65536,
    frozen: false,
  });
  const snapshot = proxy.measurements();
  (snapshot.up as { receivedBytes: number }).receivedBytes = 99;
  expect(proxy.measurements().up.receivedBytes).toBe(0);
});

it("releases the paced source pause on early upstream EOF so the native pair can close", async () => {
  let respond: (() => void) | undefined;
  const target = NodeNet.createServer((socket) => {
    respond = () => socket.end(Buffer.from("owned-response"));
    socket.on("data", () => {});
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => target.close(() => resolve())));
  const proxy = await startThrottleProxy({
    listenHost: "127.0.0.1",
    listenPort: 0,
    targetHost: "127.0.0.1",
    targetPort: (target.address() as NodeNet.AddressInfo).port,
    initial: { up: 1 },
  });
  cleanups.push(proxy.close);
  const response = new Promise<Buffer>((resolve, reject) => {
    const pieces: Buffer[] = [];
    const client = NodeNet.connect(proxy.port, "127.0.0.1", () =>
      client.write(Buffer.alloc(128 * 1024)),
    );
    client.on("data", (piece: Buffer) => pieces.push(piece));
    client.on("end", () => resolve(Buffer.concat(pieces)));
    client.on("error", reject);
    cleanups.push(async () => {
      client.destroy();
    });
  });
  await vi.waitFor(() =>
    expect(proxy.measurements().up.queuedBytes).toBeGreaterThanOrEqual(64 * 1024),
  );
  respond!();
  expect(await response).toEqual(Buffer.from("owned-response"));
  await vi.waitFor(() => expect(proxy.measurements().connections.active).toBe(0));
  expect(proxy.measurements().up.discardedBytes).toBeGreaterThan(0);
});

it.each(["received", "accepted", "discarded"] as const)(
  "makes malformed %s byte deltas leave a sticky unknown queue for direction and aggregate",
  (tag) => {
    for (const invalid of [NaN, Infinity, -1, 0.5]) {
      const measurements = createProxyMeasurements();
      measurements.observe("up", { _tag: "received", bytes: 8 });
      measurements.observe("up", { _tag: tag, bytes: invalid });
      expect(measurements.snapshot().up).toMatchObject({ complete: false, queuedBytes: null });
      expect(measurements.snapshot().total).toMatchObject({ complete: false, queuedBytes: null });
      expect(measurements.snapshot().down).toMatchObject({ complete: true, queuedBytes: 0 });
      measurements.observe("up", { _tag: "accepted", bytes: 8 });
      measurements.observe("down", { _tag: "received", bytes: 4 });
      expect(measurements.snapshot().up.queuedBytes).toBeNull();
      expect(measurements.snapshot().total.queuedBytes).toBeNull();
      expect(measurements.snapshot().down.queuedBytes).toBe(4);
    }
  },
);

it("does not report a measured zero queue when the first receipt is invalid", () => {
  const measurements = createProxyMeasurements();
  measurements.observe("down", { _tag: "received", bytes: NaN });
  expect(measurements.snapshot().down.queuedBytes).toBeNull();
  expect(measurements.snapshot().total.queuedBytes).toBeNull();
  measurements.observe("down", { _tag: "received", bytes: 8 });
  expect(measurements.snapshot().down.queuedBytes).toBeNull();
  expect(measurements.snapshot().total.queuedBytes).toBeNull();
});
