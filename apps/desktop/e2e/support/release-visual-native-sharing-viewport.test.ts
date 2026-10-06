// @effect-diagnostics nodeBuiltinImport:off - Actual SDK/controller runs on inert loopback only; synthetic PNG bytes are never native evidence.
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import * as NodeZlib from "node:zlib";
import * as NodeCrypto from "node:crypto";
import { attach } from "webdriverio";
import { afterEach, expect, it } from "vite-plus/test";
import { normalizeWebDriverRequest } from "./webdriver-request.ts";
import { inspectScreenshot } from "./remote-ui-evidence.ts";
import {
  createNativeSharingViewport,
  readNativeSharingViewport,
} from "./release-visual-native-sharing-viewport.ts";
const servers: NodeHttp.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});
function png(width: number, height: number) {
  const chunk = (name: string, data: Buffer) => {
    const value = Buffer.alloc(data.length + 12);
    value.writeUInt32BE(data.length);
    value.write(name, 4);
    data.copy(value, 8);
    value.writeUInt32BE(NodeZlib.crc32(value.subarray(4, -4)), value.length - 4);
    return value;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * (width * 4 + 1) + 1 + x * 4;
      rows[i] = x % 2 ? 210 : 20;
      rows[i + 1] = 80;
      rows[i + 2] = 50;
      rows[i + 3] = 255;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
async function fixture(mode = "owned") {
  let rect = { x: 40, y: 50, width: 1024, height: 768 },
    sets = 0,
    urlWrites = 0,
    gets = 0,
    unsafe = 0,
    scale = 1,
    changed = false,
    currentUrl = "tauri://localhost/#/settings/general";
  const original = { ...rect },
    timeout = new Error("Inert owned viewport bound exhausted."),
    facts: Record<string, boolean> = {};
  const server = NodeHttp.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const value of request) chunks.push(Buffer.from(value));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    response.setHeader("content-type", "application/json");
    let value: unknown = null;
    if (request.url?.endsWith("/url")) {
      if (request.method === "POST") {
        urlWrites++;
        if (
          (mode === "url-restore-fault" || mode === "url-and-rect-restore-fault") &&
          urlWrites > 1
        ) {
          response.statusCode = 500;
          value = { error: "unknown error", message: "Inert URL restore failure.", stacktrace: "" };
        } else currentUrl = body.url;
      } else value = currentUrl;
    } else if (request.url?.endsWith("/window/rect") && request.method === "GET") {
      gets++;
      if (mode === "read-fault") {
        response.statusCode = 500;
        value = { error: "unknown error", message: "Inert rectangle failure.", stacktrace: "" };
      } else value = rect;
    } else if (request.url?.endsWith("/window/rect") && request.method === "POST") {
      sets++;
      if (
        mode === "resize-fault" ||
        ((mode === "restore-fault" || mode === "url-and-rect-restore-fault") && sets > 1)
      ) {
        response.statusCode = 500;
        value = { error: "unknown error", message: "Inert resize failure.", stacktrace: "" };
      } else {
        if (mode !== "clamped")
          rect = {
            x: body.x ?? rect.x,
            y: body.y ?? rect.y,
            width: body.width,
            height: body.height,
          };
        value = rect;
      }
    } else if (request.url?.endsWith("/execute/sync")) {
      const chrome = mode === "changing-chrome" ? 40 + sets * 10 : 40;
      value = {
        width: rect.width - 16,
        height: rect.height - chrome,
        scale: mode === "scale" ? 2 : scale,
        screenWidth: mode === "display" ? 1280 : 1920,
        screenHeight: mode === "display" ? 960 : 1440,
      };
    } else if (request.url?.endsWith("/window/handles"))
      value = changed ? ["main", "other"] : ["main"];
    else if (request.url?.endsWith("/window")) value = "main";
    else if (request.url?.endsWith("/screenshot"))
      value = png(rect.width - 16, rect.height - 40).toString("base64");
    response.end(JSON.stringify({ value }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Inert address refused.");
  const browser = await attach({
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
      for (let attempt = 0; attempt < 12; attempt++) if (await check()) return;
      throw timeout;
    },
  };
  const identity = async () => {
    const handles = await browser.getWindowHandles();
    if (
      handles.length !== 1 ||
      handles[0] !== "main" ||
      (await browser.getWindowHandle()) !== "main"
    )
      throw new Error("Inert owned main refused.");
  };
  return {
    browser,
    owner,
    original,
    timeout,
    identity,
    facts,
    input: {
      browser,
      owner,
      original,
      identity,
      unsafeCleanup: () => unsafe++,
      observe: (value: Record<string, boolean>) => Object.assign(facts, value),
    },
    sets: () => sets,
    gets: () => gets,
    rect: () => rect,
    unsafe: () => unsafe,
    scale: () => {
      scale = 2;
    },
    changed: () => {
      changed = true;
    },
  };
}
it("actual controller/Classic SDK establishes client1280x960 despite native chrome", async () => {
  const f = await fixture();
  const source = NodeFS.readFileSync(
      new URL("../qualify-native-sharing.ts", import.meta.url),
      "utf8",
    ),
    begin = source.indexOf('          step("native-ui-window-size");'),
    end = source.indexOf('          step("native-ui-navigation");', begin);
  expect(begin).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(begin);
  const viewport = createNativeSharingViewport(f.input);
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes("(async()=>{" + source.slice(begin, end) + "})"),
    { browser: f.browser, viewport, step: () => {}, observe: () => {} },
  );
  await run();
  const measurement = await f.browser.execute(readNativeSharingViewport);
  expect(measurement).toMatchObject({ width: 1280, height: 960, scale: 1 });
  const bytes = Buffer.from(await f.browser.takeScreenshot(), "base64"),
    image = inspectScreenshot(bytes);
  expect(image).toMatchObject({ width: 1280, height: 960, nonBlank: true });
  expect(image.sha256).toBe(NodeCrypto.createHash("sha256").update(bytes).digest("hex"));
  await viewport.restore();
  expect(f.rect()).toEqual(f.original);
});
it.each([
  "url-fails",
  "visual-and-url-fail",
  "url-and-viewport-fail",
  "all-fail",
  "identity-drift",
  "undefined-url",
  "undefined-url-and-viewport",
])(
  "actual controller independently joins every cleanup after an earlier failure: %s",
  async (mode) => {
    const f = await fixture(
        mode === "undefined-url-and-viewport"
          ? "restore-fault"
          : mode === "url-and-viewport-fail" || mode === "all-fail"
            ? "url-and-rect-restore-fault"
            : mode.includes("url") && mode !== "undefined-url"
              ? "url-restore-fault"
              : "owned",
      ),
      viewport = createNativeSharingViewport(f.input),
      original = new Error("Inert exact visual failure.");
    let finished = false,
      rectRestores = 0,
      verifications = 0;
    const restore = viewport.restore;
    viewport.restore = () => {
      rectRestores++;
      return restore();
    };
    const url = f.browser.url.bind(f.browser),
      browser = Object.create(f.browser);
    Object.defineProperty(browser, "url", {
      value: async (value: string) => {
        if (finished && mode.startsWith("undefined-url")) throw undefined;
        return url(value);
      },
    });
    const source = NodeFS.readFileSync(
        new URL("../qualify-native-sharing.ts", import.meta.url),
        "utf8",
      ),
      begin = source.indexOf("        let visualFailed"),
      end = source.indexOf("        if (captured.size", begin);
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes("(async()=>{" + source.slice(begin, end) + "})"),
      {
        browser,
        viewport,
        owner: f.owner,
        original: "tauri://localhost/#/settings/general",
        verify: async () => {
          verifications++;
          await viewport.verify();
        },
        step: () => {},
        observe: () => {},
        markUnsafe: f.input.unsafeCleanup,
        evidence: "/inert/evidence",
        captured: new Set(),
        captures: [],
        write: () => {},
        withNativeSharingRoute: () => {},
        readNativeSharingRoute: () => {},
        routePorts: {},
        createNativeSharingBrowserPorts: async () => ({}),
        runNativeSharingVisual: async () => {
          finished = true;
          if (mode === "identity-drift") f.changed();
          if (mode === "visual-and-url-fail" || mode === "all-fail") throw original;
          return {};
        },
      },
    );
    let failed = false,
      error: unknown;
    try {
      await run();
    } catch (value) {
      failed = true;
      error = value;
    }
    expect(failed).toBe(true);
    if (mode === "visual-and-url-fail" || mode === "all-fail") expect(error).toBe(original);
    else if (mode.startsWith("undefined-url")) expect(error).toBeUndefined();
    else if (mode === "identity-drift") expect(error).toBeInstanceOf(Error);
    else
      expect(error).toMatchObject({
        name: "unknown error",
        message: expect.stringContaining("Inert URL restore failure."),
      });
    expect(rectRestores).toBe(1);
    expect(verifications).toBe(1);
    expect(f.unsafe()).toBeGreaterThan(0);
    if (mode === "url-fails" || mode === "visual-and-url-fail" || mode === "undefined-url")
      expect(f.rect()).toEqual(f.original);
  },
);
it.each(["scale", "display", "changing-chrome"])(
  "refuses impossible or drifting native client geometry: %s",
  async (mode) => {
    const f = await fixture(mode),
      viewport = createNativeSharingViewport(f.input);
    await expect(viewport.fit()).rejects.toThrow();
    expect(f.sets()).toBeLessThanOrEqual(3);
  },
);
it.each(["read-fault", "resize-fault"])("preserves actual SDK exception: %s", async (mode) => {
  const f = await fixture(mode),
    viewport = createNativeSharingViewport(f.input);
  await expect(viewport.fit()).rejects.toMatchObject({ name: "unknown error" });
});
it("does not widen readiness when the native driver refuses the requested outer rectangle", async () => {
  const f = await fixture("clamped"),
    viewport = createNativeSharingViewport(f.input);
  await expect(viewport.fit()).rejects.toBe(f.timeout);
  expect(f.sets()).toBe(1);
  await viewport.restore();
  expect(f.rect()).toEqual(f.original);
});
it("verifies exact main before a resize and every later capture viewport fence", async () => {
  const f = await fixture(),
    viewport = createNativeSharingViewport(f.input);
  await viewport.fit();
  f.changed();
  await expect(viewport.verify()).rejects.toThrow();
  const before = f.sets();
  await expect(viewport.restore()).rejects.toThrow();
  expect(f.sets()).toBe(before);
});
it("refuses changed scale at a post-original fence", async () => {
  const f = await fixture(),
    viewport = createNativeSharingViewport(f.input);
  await viewport.fit();
  f.scale();
  await expect(viewport.verify()).rejects.toThrow();
});
it("restores the full original rectangle and retains a repeated failed restoration", async () => {
  const f = await fixture("restore-fault"),
    viewport = createNativeSharingViewport(f.input);
  await viewport.fit();
  const first = viewport.restore(),
    second = viewport.restore();
  expect(first).toBe(second);
  await expect(first).rejects.toMatchObject({ name: "unknown error" });
  await expect(second).rejects.toThrow();
  expect(f.unsafe()).toBe(1);
});
it("publishes the joined restoration promise before an optional observer can reenter", async () => {
  const f = await fixture();
  let reentered: Promise<void> | undefined,
    attempted = false;
  const viewport = createNativeSharingViewport({
    ...f.input,
    observe: (facts) => {
      if (facts.viewportRestoreAttempted && !attempted) {
        attempted = true;
        reentered = viewport.restore();
      }
    },
  });
  await viewport.fit();
  const restored = viewport.restore();
  expect(restored).toBe(reentered);
  await restored;
  expect(f.sets()).toBe(2);
  expect(f.rect()).toEqual(f.original);
});
it("optional observer failures prohibit false geometry success without replacing genuine SDK failure", async () => {
  const f = await fixture(),
    viewport = createNativeSharingViewport({
      ...f.input,
      observe: () => {
        throw new Error("Inert observer fault.");
      },
    });
  await expect(viewport.fit()).rejects.toThrow();
  expect(f.unsafe()).toBe(1);
  const fault = await fixture("resize-fault"),
    failed = createNativeSharingViewport({
      ...fault.input,
      observe: () => {
        throw new Error("Inert observer fault.");
      },
    });
  await expect(failed.fit()).rejects.toMatchObject({ name: "unknown error" });
});
it.each(["owned", "visual-fails", "restore-fails", "both-fail"])(
  "actual controller joins original-rectangle restoration and preserves the original failure: %s",
  async (mode) => {
    const f = await fixture(
        mode.includes("restore") || mode === "both-fail" ? "restore-fault" : "owned",
      ),
      viewport = createNativeSharingViewport(f.input),
      original = new Error("Inert exact visual failure."),
      facts: Record<string, boolean> = {};
    const source = NodeFS.readFileSync(
        new URL("../qualify-native-sharing.ts", import.meta.url),
        "utf8",
      ),
      begin = source.indexOf("        let visualFailed"),
      end = source.indexOf("        if (captured.size", begin);
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes("(async()=>{" + source.slice(begin, end) + "})"),
      {
        browser: f.browser,
        viewport,
        owner: f.owner,
        original: "tauri://localhost/#/settings/general",
        verify: viewport.verify,
        step: () => {},
        observe: (value: Record<string, boolean>) => Object.assign(facts, value),
        markUnsafe: f.input.unsafeCleanup,
        evidence: "/inert/evidence",
        captured: new Set(),
        captures: [],
        write: () => {},
        withNativeSharingRoute: () => {},
        readNativeSharingRoute: () => {},
        routePorts: {},
        createNativeSharingBrowserPorts: async () => ({}),
        runNativeSharingVisual: async () => {
          if (mode === "visual-fails" || mode === "both-fail") throw original;
          return {};
        },
      },
    );
    if (mode === "owned") await expect(run()).resolves.toBeUndefined();
    else if (mode === "visual-fails" || mode === "both-fail")
      await expect(run()).rejects.toBe(original);
    else await expect(run()).rejects.toMatchObject({ name: "unknown error" });
    if (mode === "owned" || mode === "visual-fails") {
      expect(f.rect()).toEqual(f.original);
      await expect(viewport.verify()).resolves.toBeUndefined();
    } else expect(f.unsafe()).toBeGreaterThan(0);
  },
);
