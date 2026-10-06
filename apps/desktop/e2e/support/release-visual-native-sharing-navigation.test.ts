// @effect-diagnostics nodeBuiltinImport:off - Actual SDK/controller execution uses only an inert loopback protocol port.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { afterEach, expect, it } from "vite-plus/test";
import { attach } from "webdriverio";
import { createNativeSharingBrowserPorts } from "./release-visual-native-sharing-browser.ts";
import { normalizeWebDriverRequest } from "./webdriver-request.ts";

const servers: NodeHttp.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function run(mode: "settles" | "never-settles" | "driver-fails") {
  const target = "tauri://localhost/#/settings/general";
  const observation: Record<string, boolean> = {};
  const timeout = new Error("Inert owned navigation observation exhausted.");
  let current = "tauri://localhost/index.html",
    navigations = 0,
    themeReads = 0;
  const server = NodeHttp.createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Consume original inert SDK request bytes before responding.
    }
    response.setHeader("content-type", "application/json");
    let value: unknown = null;
    if (request.method === "POST" && request.url?.endsWith("/url")) {
      navigations++;
      if (navigations > 1 && mode === "settles") current = target;
    } else if (request.method === "GET" && request.url?.endsWith("/url")) {
      if (mode === "driver-fails") {
        response.statusCode = 500;
        value = { error: "unknown error", message: "Inert protocol failure.", stacktrace: "" };
      } else {
        value = current;
        if (mode === "settles") current = target;
      }
    }
    response.end(JSON.stringify({ value }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Inert protocol port refused.");
  const client = await attach({
    sessionId: "inert-owned-session",
    capabilities: { browserName: "wry", "wdio:enforceWebDriverClassic": true },
    hostname: "127.0.0.1",
    port: address.port,
    logLevel: "silent",
    connectionRetryCount: 0,
    transformRequest: normalizeWebDriverRequest,
  });
  const owner = {
    until: async (check: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 3; attempt++) if (await check()) return;
      throw timeout;
    },
  };
  const browser = {
    setWindowSize: async () => {},
    url: client.url.bind(client),
    getUrl: client.getUrl.bind(client),
    $: () => ({
      waitForDisplayed: async () => {},
      getText: async () => {
        themeReads++;
        return "System";
      },
    }),
  };
  const source = NodeFS.readFileSync(
    new URL("../qualify-native-sharing.ts", import.meta.url),
    "utf8",
  );
  const begin = source.indexOf('          step("native-ui-window-size");');
  const end = source.indexOf('          step("native-sharing-scenes");', begin);
  if (begin < 0 || end <= begin) throw new Error("Actual controller seam refused.");
  const execute = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes("(async()=>{" + source.slice(begin, end) + "})"),
    {
      step: () => {},
      observe: (facts: Record<string, boolean>) => Object.assign(observation, facts),
      browser,
      viewport: { fit: async () => {} },
      owner,
      createNativeSharingBrowserPorts,
      evidence: "/inert/evidence",
      captured: new Set(),
      verify: async () => {},
      markUnsafe: () => {},
      withNativeSharingRoute: () => {},
      readNativeSharingRoute: () => {},
      routePorts: {},
      captures: [],
      write: () => {},
    },
  );
  return { execute, observation, timeout, themeReads: () => themeReads };
}

it("admits actual UI ports only after Classic native navigation reaches the requested settings URL", async () => {
  const value = await run("settles");
  await expect(value.execute()).resolves.toBeUndefined();
  expect(value.observation.uiPortsCreated).toBe(true);
});

it("exhausts the owned readiness bound without reading UI when native navigation never settles", async () => {
  const value = await run("never-settles");
  await expect(value.execute()).rejects.toBe(value.timeout);
  expect(value.themeReads()).toBe(0);
  expect(value.observation.uiPortsCreated).not.toBe(true);
});

it("preserves the actual SDK URL-read failure and performs no later UI action", async () => {
  const value = await run("driver-fails");
  await expect(value.execute()).rejects.toMatchObject({ name: "unknown error" });
  expect(value.themeReads()).toBe(0);
  expect(value.observation.uiPortsCreated).not.toBe(true);
});
