// @effect-diagnostics nodeBuiltinImport:off - Actual installed SDK uses an inert protocol peer only.
import * as NodeHttp from "node:http";
import { attach } from "webdriverio";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { normalizeWebDriverRequest } from "./webdriver-request.ts";
import { createNativeSharingGeometry } from "./release-visual-native-sharing-geometry.ts";

const original = {
  rectangle: { x: 40, y: 50, width: 1024, height: 768 },
  resizeWidth: 1008,
  resizeHeight: 728,
  scaleFactor: 1,
};
const lease = "770f9c54-9e20-4c1c-9548-d04dba0f222a";
const servers: NodeHttp.Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function fixture() {
  let snapshot = structuredClone(original);
  const requests: Record<string, unknown>[] = [];
  const server = NodeHttp.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url?.endsWith("/window")) {
      response.end(JSON.stringify({ value: "main" }));
      return;
    }
    if (!request.url?.endsWith("/execute/sync")) {
      response.statusCode = 500;
      response.end(
        JSON.stringify({
          value: {
            error: "unknown error",
            message: "Cached geometry must not be used.",
            stacktrace: "",
          },
        }),
      );
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString()),
      input = body.args[0];
    expect(body.script).toContain("desktop_e2e_main_window_geometry");
    requests.push(input);
    let value: unknown;
    if (input.operation === "acquire") value = { lease, snapshot };
    else if (input.operation === "read") value = snapshot;
    else if (input.operation === "set") {
      expect(input.lease).toBe(lease);
      expect(input.expected).toEqual(snapshot);
      snapshot = { ...snapshot, rectangle: input.target };
      value = { requested: true };
    } else {
      expect(input.operation).toBe("restore");
      expect(input.lease).toBe(lease);
      snapshot = structuredClone(original);
      value = { requested: true };
    }
    response.end(JSON.stringify({ value }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Inert port refused.");
  const browser = await attach({
    sessionId: "inert-owned",
    capabilities: { browserName: "wry", "wdio:enforceWebDriverClassic": true },
    hostname: "127.0.0.1",
    port: address.port,
    logLevel: "silent",
    connectionRetryCount: 0,
    transformRequest: normalizeWebDriverRequest,
  });
  let unsafe = 0;
  return {
    browser,
    requests,
    geometry: createNativeSharingGeometry({ browser, unsafeCleanup: () => unsafe++ }),
    unsafe: () => unsafe,
  };
}
it("uses the same actual SDK only for the native acquire/read/write/restore command", async () => {
  const f = await fixture();
  const cachedGetter = f.browser.getWindowRect,
    cachedSetter = f.browser.setWindowRect;
  const first = await f.geometry.acquire();
  expect(first).toEqual(original);
  expect(Object.isFrozen(first.rectangle)).toBe(true);
  await f.geometry.set(await f.geometry.read(), { x: 40, y: 50, width: 1296, height: 1000 });
  const restore = f.geometry.restore();
  expect(f.geometry.restore()).toBe(restore);
  await restore;
  expect(await f.geometry.read()).toEqual(original);
  expect(f.requests.map((value) => value.operation)).toEqual([
    "acquire",
    "read",
    "set",
    "restore",
    "read",
  ]);
  expect(f.browser.getWindowRect).toBe(cachedGetter);
  expect(f.browser.setWindowRect).toBe(cachedSetter);
  expect(f.unsafe()).toBe(0);
  await expect(f.geometry.set(first, original.rectangle)).rejects.toThrow();
});
it("shares original acquisition without creating a second native baseline", async () => {
  const f = await fixture(),
    first = f.geometry.acquire();
  expect(f.geometry.acquire()).toBe(first);
  await first;
  expect(f.requests).toHaveLength(1);
});

it.each(["proxy", "getter", "extra", "zero", "scale", "lease"])(
  "refuses unsafe native reply metadata before exposing a lease: %s",
  async (mode) => {
    let getters = 0,
      unsafe = 0,
      calls = 0;
    const reply: Record<string, unknown> = { lease, snapshot: structuredClone(original) };
    if (mode === "getter")
      Object.defineProperty(reply, "snapshot", {
        enumerable: true,
        get: () => {
          getters++;
          return original;
        },
      });
    if (mode === "extra") reply.privateValue = "inert private value";
    if (mode === "zero")
      reply.snapshot = { ...original, rectangle: { ...original.rectangle, width: 0 } };
    if (mode === "scale") reply.snapshot = { ...original, scaleFactor: 2 };
    if (mode === "lease") reply.lease = "foreign";
    const geometry = createNativeSharingGeometry({
      browser: {
        execute: async () => {
          calls++;
          return mode === "proxy"
            ? new Proxy(reply, {
                ownKeys: () => {
                  getters++;
                  return Reflect.ownKeys(reply);
                },
              })
            : reply;
        },
      } as never,
      unsafeCleanup: () => unsafe++,
    });
    await expect(geometry.acquire()).rejects.toThrow();
    await expect(geometry.read()).rejects.toThrow();
    expect(calls).toBe(1);
    expect(getters).toBe(0);
    expect(unsafe).toBe(1);
  },
);
it.each(["error", "undefined"])(
  "retains the original native refusal even after cleanup: %s",
  async (mode) => {
    const originalFailure =
      mode === "undefined" ? undefined : Object.freeze(new Error("Inert original native failure."));
    let unsafe = 0,
      calls = 0;
    const geometry = createNativeSharingGeometry({
      browser: {
        execute: async () => {
          calls++;
          throw originalFailure;
        },
      } as never,
      unsafeCleanup: () => unsafe++,
    });
    let failed = false,
      failure: unknown;
    try {
      await geometry.acquire();
    } catch (error) {
      failed = true;
      failure = error;
    }
    expect(failed).toBe(true);
    expect(failure).toBe(originalFailure);
    await expect(geometry.restore()).rejects.toThrow();
    expect(calls).toBe(1);
    expect(unsafe).toBe(1);
  },
);
it("the supported invoke bridge is required and a write acknowledgement is not a resulting rectangle", async () => {
  vi.stubGlobal("window", {});
  const geometry = createNativeSharingGeometry({
    browser: {
      execute: async (run: (request: unknown) => Promise<unknown>, request: unknown) =>
        run(request),
    } as never,
    unsafeCleanup: () => {},
  });
  await expect(geometry.acquire()).rejects.toThrow();
  const commands: string[] = [];
  vi.stubGlobal("window", {
    __TAURI__: {
      core: {
        invoke: async (command: string) => {
          commands.push(command);
          return { lease, snapshot: original };
        },
      },
    },
  });
  const invalidAck = createNativeSharingGeometry({
    browser: {
      execute: async (run: (request: unknown) => Promise<unknown>, request: unknown) =>
        run(request),
    } as never,
    unsafeCleanup: () => {},
  });
  const native = await invalidAck.acquire();
  await expect(invalidAck.set(native, original.rectangle)).rejects.toThrow();
  expect(commands).toEqual([
    "desktop_e2e_main_window_geometry",
    "desktop_e2e_main_window_geometry",
  ]);
});
