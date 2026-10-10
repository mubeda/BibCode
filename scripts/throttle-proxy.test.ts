// @effect-diagnostics nodeBuiltinImport:off - The proxy test drives raw loopback sockets.
// @effect-diagnostics globalTimers:off - The freeze check waits a bounded real time.
// @effect-diagnostics globalDate:off - The pacing check measures elapsed wall-clock time.
// @effect-diagnostics globalFetch:off - The test drives the proxy's loopback control API.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeNet from "node:net";
import * as NodeURL from "node:url";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { startThrottleProxy, startControlServer, runThrottleProxyMain } from "./throttle-proxy.ts";

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
  it.each(["observe", "throw"])(
    "keeps both directions original when an optional observer mutates its copy: %s",
    async (mode) => {
      const payload = Buffer.from("Owned proxy observation payload");
      const server = NodeNet.createServer((socket) =>
        socket.once("data", (bytes) => socket.end(bytes)),
      );
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Inert port missing");
      const seen: Array<{ connection: string; direction: string; bytes: Buffer }> = [];
      let closedCount = 0;
      let resolveClosed: () => void = () => {};
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const proxy = await startThrottleProxy({
        listenHost: "127.0.0.1",
        listenPort: 0,
        targetHost: "127.0.0.1",
        targetPort: address.port,
        observeTraffic: (connection, direction, bytes) => {
          seen.push({ connection, direction, bytes: Buffer.from(bytes) });
          bytes.fill(0);
          if (mode === "throw") throw undefined;
          return undefined;
        },
        observeClosed: () => {
          closedCount++;
          resolveClosed();
          if (mode === "throw") throw undefined;
          return undefined;
        },
      });
      cleanups.push(proxy.close);
      const received = await new Promise<Buffer>((resolve, reject) => {
        const client = NodeNet.connect(proxy.port, "127.0.0.1", () => client.write(payload));
        const parts: Buffer[] = [];
        client.on("data", (bytes: Buffer) => parts.push(bytes));
        client.on("end", () => resolve(Buffer.concat(parts)));
        client.on("error", reject);
      });
      expect(received).toEqual(payload);
      expect(seen.length).toBeGreaterThanOrEqual(2);
      await closed;
      expect(closedCount).toBe(1);
      expect(new Set(seen.map((value) => value.connection)).size).toBe(1);
      for (const direction of ["request", "reply"])
        expect(
          Buffer.concat(
            seen.filter((value) => value.direction === direction).map((value) => value.bytes),
          ),
        ).toEqual(payload);
    },
  );
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
