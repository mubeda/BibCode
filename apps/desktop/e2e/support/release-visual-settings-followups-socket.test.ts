// @effect-diagnostics nodeBuiltinImport:off - Fake sockets/clock only; no local server, provider or network.
import { expect, it } from "vite-plus/test";
import {
  startSettingsFollowupSocket,
  type SettingsFollowupSocketPorts,
} from "./release-visual-settings-followups-socket.ts";
class Socket {
  destroyed = false;
  paused = false;
  writes: Buffer[] = [];
  writeReady = true;
  listeners = new Map<string, Array<(value?: unknown) => void>>();
  on(event: string, listener: (value: never) => void) {
    const values = this.listeners.get(event) ?? [];
    values.push(listener as (value?: unknown) => void);
    this.listeners.set(event, values);
    return this;
  }
  once(event: string, listener: () => void) {
    return this.on(event, listener);
  }
  emit(event: string, value?: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
  write(bytes: Buffer) {
    this.writes.push(Buffer.from(bytes));
    return this.writeReady;
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  destroy() {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close");
    }
  }
}
function fixture(mode = "owned") {
  let accept: (client: Socket) => void = () => {},
    created = 0,
    closed = 0;
  const listenerError = new Error("Inert socket listener refused."),
    serverListeners = new Map<string, (error: Error) => void>();
  const upstreams: Socket[] = [],
    timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
  const ports: SettingsFollowupSocketPorts = {
    createServer: (callback) => {
      created++;
      accept = callback;
      return {
        on: (event, callback) => {
          serverListeners.set(event, callback);
        },
        listen: (port, host, ready) => {
          expect([port, host]).toEqual([4889, "127.0.0.1"]);
          if (mode.startsWith("init-failure")) serverListeners.get("error")!(listenerError);
          else ready();
        },
        close: (done) => {
          closed++;
          done(mode.includes("close-failure") ? listenerError : undefined);
        },
      };
    },
    connect: (port, host) => {
      expect([port, host]).toEqual([4888, "127.0.0.1"]);
      const socket = new Socket();
      upstreams.push(socket);
      return socket;
    },
    schedule: (run, ms) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      if (timer && typeof timer === "object" && "cancelled" in timer) timer.cancelled = true;
    },
  };
  return {
    ports,
    connect: () => {
      const client = new Socket();
      accept(client);
      return { client, upstream: upstreams[upstreams.length - 1]! };
    },
    created: () => created,
    closed: () => closed,
    timers,
    listenerError,
    emitServerError: () => serverListeners.get("error")!(listenerError),
  };
}
const request = Buffer.from(
  "GET /ws-e2ee HTTP/1.1\r\nHost:127.0.0.1:4889\r\nUpgrade:websocket\r\nConnection:Upgrade\r\n\r\n",
);
const upgrade = Buffer.from(
  "HTTP/1.1 101 Switching Protocols\r\nUpgrade:websocket\r\nConnection:Upgrade\r\n\r\n",
);
const frame = (size: number, value: number) => {
  const head = Buffer.alloc(size < 126 ? 2 : 4);
  head[0] = 0x82;
  if (size < 126) head[1] = size;
  else {
    head[1] = 126;
    head.writeUInt16BE(size, 2);
  }
  return Buffer.concat([head, Buffer.alloc(size, value)]);
};
const hello = frame(48, 1),
  auth = frame(120, 2),
  config = frame(4096, 3);
const flush = async () => {
  for (let tick = 0; tick < 10; tick++) await Promise.resolve();
};
it.each([
  { CI: undefined, platform: "linux" },
  { CI: "true", platform: "darwin" },
])("refuses outside CI/Linux before source, listener or socket operations", async (guard) => {
  const f = fixture();
  let admitted = 0;
  await expect(
    startSettingsFollowupSocket({
      ...guard,
      admitOwner: async () => {
        admitted++;
      },
      ports: f.ports,
    }),
  ).rejects.toThrow();
  expect(admitted).toBe(0);
  expect(f.created()).toBe(0);
});

it("refuses a second configuration hold after the first original-byte release", async () => {
  const f = fixture(),
    owner = await startSettingsFollowupSocket({
      CI: "true",
      platform: "linux",
      admitOwner: async () => {},
      ports: f.ports,
    });
  await owner.armNextConfiguration();
  const pair = f.connect();
  pair.client.emit("data", request);
  pair.upstream.emit("data", Buffer.concat([upgrade, hello, auth, config]));
  await flush();
  await owner.release();
  pair.client.destroy();
  await expect(owner.armNextConfiguration()).rejects.toThrow();
  await owner.close();
});
it("retains post-listen errors as the original socket refusal and joins only owned peers", async () => {
  const f = fixture(),
    owner = await startSettingsFollowupSocket({
      CI: "true",
      platform: "linux",
      admitOwner: async () => {},
      ports: f.ports,
    });
  await owner.armNextConfiguration();
  const pair = f.connect();
  pair.client.emit("data", request);
  pair.upstream.emit("data", Buffer.concat([upgrade, hello, auth, config]));
  await flush();
  f.emitServerError();
  await expect(owner.verifyHolding()).rejects.toBe(f.listenerError);
  expect(pair.client.destroyed && pair.upstream.destroyed).toBe(true);
  await owner.close();
});
it("retains a failed listener close on repeated cleanup instead of reporting a false joined close", async () => {
  const f = fixture("close-failure"),
    owner = await startSettingsFollowupSocket({
      CI: "true",
      platform: "linux",
      admitOwner: async () => {},
      ports: f.ports,
    });
  await expect(owner.close()).rejects.toBe(f.listenerError);
  await expect(owner.close()).rejects.toBe(f.listenerError);
  expect(owner.observation().closed).toBe(false);
  expect(f.closed()).toBe(1);
});
it("preserves initial listener failure and signals unjoined initialization cleanup", async () => {
  const f = fixture("init-failure-close-failure");
  let unsafe = 0;
  await expect(
    startSettingsFollowupSocket({
      CI: "true",
      platform: "linux",
      admitOwner: async () => {},
      ports: f.ports,
      observeUnsafeCleanup: () => {
        unsafe++;
      },
    }),
  ).rejects.toBe(f.listenerError);
  expect(unsafe).toBe(1);
  expect(f.closed()).toBe(1);
});
it("cancels held and drain timers when a backpressured socket closes during owned shutdown", async () => {
  const f = fixture(),
    owner = await startSettingsFollowupSocket({
      CI: "true",
      platform: "linux",
      admitOwner: async () => {},
      ports: f.ports,
    });
  await owner.armNextConfiguration();
  const pair = f.connect();
  pair.client.writeReady = false;
  pair.client.emit("data", request);
  pair.upstream.emit("data", Buffer.concat([upgrade, hello, auth, config]));
  await flush();
  await owner.close();
  expect(f.timers.every((value) => value.cancelled)).toBe(true);
  expect(owner.observation().closed).toBe(true);
});
it("owns one exact real-byte hold/release and joins its listeners/sockets without claiming auth readiness", async () => {
  const f = fixture();
  let checks = 0;
  const owner = await startSettingsFollowupSocket({
    CI: "true",
    platform: "linux",
    admitOwner: async () => {
      checks++;
    },
    ports: f.ports,
  });
  await owner.armNextConfiguration();
  const pair = f.connect();
  pair.client.emit("data", request);
  pair.upstream.emit("data", Buffer.concat([upgrade, hello, auth, config]));
  await flush();
  expect(Buffer.concat(pair.upstream.writes)).toEqual(request);
  expect(Buffer.concat(pair.client.writes)).toEqual(Buffer.concat([upgrade, hello, auth]));
  expect(owner.observation()).toMatchObject({
    holding: true,
    activeNoiseConnections: 1,
    acceptedNoiseConnections: 1,
  });
  await owner.verifyHolding();
  expect(checks).toBeGreaterThan(1);
  await owner.release();
  expect(Buffer.concat(pair.client.writes)).toEqual(Buffer.concat([upgrade, hello, auth, config]));
  expect(owner.observation().holding).toBe(false);
  await owner.close();
  expect(pair.client.destroyed && pair.upstream.destroyed).toBe(true);
  expect(owner.observation()).toMatchObject({ closed: true, activeNoiseConnections: 0 });
  expect(f.closed()).toBe(1);
  expect(f.timers.every((timer) => timer.cancelled)).toBe(true);
});
it("keeps initial ordinary transport bytes unmodified and will not arm over a live saved connection", async () => {
  const f = fixture();
  const owner = await startSettingsFollowupSocket({
    CI: "true",
    platform: "linux",
    admitOwner: async () => {},
    ports: f.ports,
  });
  const pair = f.connect();
  pair.client.emit("data", request);
  pair.upstream.emit("data", Buffer.concat([upgrade, hello, auth, config]));
  await flush();
  expect(Buffer.concat(pair.client.writes)).toEqual(Buffer.concat([upgrade, hello, auth, config]));
  await expect(owner.armNextConfiguration()).rejects.toThrow();
  await owner.close();
});
it("expires the finite20s hold and refuses late/foreign source proof while closing only owned sockets", async () => {
  const f = fixture();
  let foreign = false;
  const original = new Error("Inert changed owned server.");
  const owner = await startSettingsFollowupSocket({
    CI: "true",
    platform: "linux",
    admitOwner: async () => {
      if (foreign) throw original;
    },
    ports: f.ports,
  });
  await owner.armNextConfiguration();
  const pair = f.connect();
  pair.client.emit("data", request);
  pair.upstream.emit("data", Buffer.concat([upgrade, hello, auth, config]));
  await flush();
  foreign = true;
  await expect(owner.verifyHolding()).rejects.toBe(original);
  foreign = false;
  const timeout = f.timers.find((timer) => timer.ms === 20000 && !timer.cancelled);
  expect(timeout).toBeDefined();
  timeout!.run();
  await expect(owner.release()).rejects.toThrow();
  expect(pair.client.destroyed && pair.upstream.destroyed).toBe(true);
  await owner.close();
});
