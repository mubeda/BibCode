// @effect-diagnostics nodeBuiltinImport:off - Actual SDK/controller runs on inert loopback only; synthetic PNG bytes are never native evidence.
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import * as NodeZlib from "node:zlib";
import * as NodeCrypto from "node:crypto";
import { attach } from "webdriverio";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { normalizeWebDriverRequest } from "./webdriver-request.ts";
import { inspectScreenshot } from "./remote-ui-evidence.ts";
import { classifyQualificationFailure } from "./chat-upload-evidence.ts";
import * as NativeViewport from "./release-visual-native-sharing-viewport.ts";
import {
  createNativeSharingViewport,
  readNativeSharingViewport,
} from "./release-visual-native-sharing-viewport.ts";
import { createNativeSharingGeometry } from "./release-visual-native-sharing-geometry.ts";
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
    restoring = false,
    nativeRestoreReads = 0,
    currentUrl = "tauri://localhost/#/settings/general";
  const original = { ...rect },
    timeout = new Error("Inert owned viewport bound exhausted."),
    facts: Record<string, boolean | null> = {};
  const initialRects: Record<string, unknown> = {
    "initial-zero": { x: 0, y: 0, width: 0, height: 0 },
    "initial-negative": { x: -1, y: 0, width: 1024, height: 768 },
    "initial-overflow-x": { x: 1000, y: 0, width: 1024, height: 768 },
    "initial-overflow-y": { x: 0, y: 900, width: 1024, height: 768 },
    "initial-fractional": { x: 0, y: 0, width: 1024.5, height: 768 },
    "initial-missing": { x: 0, y: 0, height: 768 },
    "initial-extra": { x: 0, y: 0, width: 1024, height: 768, privateValue: "inert value" },
  };
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
      if (mode === "read-fault" || mode === "initial-read-fault") {
        response.statusCode = 500;
        value = { error: "unknown error", message: "Inert rectangle failure.", stacktrace: "" };
      } else
        value =
          mode === "cached-size-defect"
            ? { x: 0, y: 0, width: 0, height: 0 }
            : Object.hasOwn(initialRects, mode)
              ? initialRects[mode]
              : rect;
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
      const operation = body.args?.[0]?.operation;
      if (operation) {
        if (operation === "set") {
          sets++;
          rect = { ...body.args[0].target };
        }
        if (operation === "restore") {
          sets++;
          restoring = true;
          if (mode !== "native-restore-delayed" && mode !== "native-restore-unsettled")
            rect = { ...original };
        }
        if (operation === "read" && restoring) {
          nativeRestoreReads++;
          if (mode === "native-restore-delayed" && nativeRestoreReads === 3) rect = { ...original };
        }
        const snapshot = {
          rectangle: { ...rect },
          resizeWidth: rect.width - 16,
          resizeHeight: rect.height - 40,
          scaleFactor: scale,
        };
        value =
          operation === "acquire"
            ? { lease: "770f9c54-9e20-4c1c-9548-d04dba0f222a", snapshot }
            : operation === "read"
              ? snapshot
              : { requested: true };
        if (operation === "restore" && mode === "native-restore-refusal") {
          response.statusCode = 500;
          value = {
            error: "unknown error",
            message: "Inert native restoration refusal.",
            stacktrace: "",
          };
        }
      } else {
        const chrome = mode === "changing-chrome" ? 40 + sets * 10 : 40;
        value = {
          width: rect.width - 16,
          height: rect.height - chrome,
          scale: mode === "scale" ? 2 : scale,
          screenWidth: mode === "display" ? 1280 : 1920,
          screenHeight: mode === "display" ? 960 : 1440,
        };
      }
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
      geometry: {
        read: async () => {
          const rectangle = await browser.getWindowRect();
          return {
            rectangle,
            resizeWidth: rectangle.width - 16,
            resizeHeight: rectangle.height - 40,
            scaleFactor: scale,
          };
        },
        set: async (_expected: unknown, target: typeof rect) => {
          await browser.setWindowRect(target.x, target.y, target.width, target.height);
        },
        restore: async () => {
          await browser.setWindowRect(original.x, original.y, original.width, original.height);
        },
      },
      identity,
      unsafeCleanup: () => unsafe++,
      observe: (value: Record<string, boolean | null>) => Object.assign(facts, value),
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
    nativeGeometry: {
      read: async () => ({
        rectangle: { ...rect },
        resizeWidth: rect.width - 16,
        resizeHeight: rect.height - 40,
        scaleFactor: scale,
      }),
      set: async (_expected: unknown, target: typeof rect) => {
        sets++;
        rect = { ...target };
      },
      restore: async () => {
        sets++;
        rect = { ...original };
      },
    },
  };
}
it("fits and restores a genuine native frame without the defective cached SDK geometry", async () => {
  const f = await fixture("cached-size-defect");
  const viewport = createNativeSharingViewport({ ...f.input, geometry: f.nativeGeometry });
  await viewport.fit();
  await viewport.verify();
  await viewport.restore();
  expect(f.rect()).toEqual(f.original);
  expect(f.gets()).toBe(0);
  expect(f.sets()).toBe(2);
  expect(f.unsafe()).toBe(0);
});
it("the actual controller acquires the native original before fitting and exact restoration on the same SDK", async () => {
  const f = await fixture("cached-size-defect"),
    source = NodeFS.readFileSync(new URL("../qualify-native-sharing.ts", import.meta.url), "utf8");
  const begin = source.indexOf('        step("native-original-size");'),
    end = source.indexOf('        step("native-initial-verification");', begin);
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      "(async()=>{" + source.slice(begin, end) + "\nreturn viewport;})",
    ),
    {
      browser: f.browser,
      owner: f.owner,
      createNativeSharingGeometry,
      createNativeSharingViewport,
      markUnsafe: f.input.unsafeCleanup,
      step: () => {},
      observe: () => {},
      guard: async () => {},
      verifyNativeSharingWindow: async () => {},
      validateNativeSharingIdentity: () => {},
      collectNativeSharingIdentity: async () => ({}),
      identity: {},
      endpoint: {},
      descriptor: () => {},
    },
  );
  const viewport = await run();
  await viewport.fit();
  await viewport.restore();
  expect(f.rect()).toEqual(f.original);
  expect(f.gets()).toBe(0);
  expect(f.sets()).toBe(2);
  expect(f.unsafe()).toBe(0);
});
const unknownOriginalFacts = {
  originalRectRecordMatched: null,
  originalRectKeysMatched: null,
  originalRectNumbersFinite: null,
  originalRectNumbersInteger: null,
  originalRectPositionNonnegative: null,
  originalRectDimensionsPositive: null,
  originalRectHorizontalWithinDisplay: null,
  originalRectVerticalWithinDisplay: null,
};
const admittedOriginalFacts = {
  originalRectRecordMatched: true,
  originalRectKeysMatched: true,
  originalRectNumbersFinite: true,
  originalRectNumbersInteger: true,
  originalRectPositionNonnegative: true,
  originalRectDimensionsPositive: true,
  originalRectHorizontalWithinDisplay: true,
  originalRectVerticalWithinDisplay: true,
};
it.each([
  { mode: "owned", want: admittedOriginalFacts },
  {
    mode: "initial-zero",
    want: { ...admittedOriginalFacts, originalRectDimensionsPositive: false },
  },
  {
    mode: "initial-negative",
    want: {
      ...admittedOriginalFacts,
      originalRectPositionNonnegative: false,
      originalRectHorizontalWithinDisplay: false,
    },
  },
  {
    mode: "initial-overflow-x",
    want: { ...admittedOriginalFacts, originalRectHorizontalWithinDisplay: false },
  },
  {
    mode: "initial-overflow-y",
    want: { ...admittedOriginalFacts, originalRectVerticalWithinDisplay: false },
  },
  {
    mode: "initial-fractional",
    want: {
      ...unknownOriginalFacts,
      originalRectRecordMatched: true,
      originalRectKeysMatched: true,
      originalRectNumbersInteger: false,
    },
  },
  {
    mode: "initial-missing",
    want: {
      ...unknownOriginalFacts,
      originalRectRecordMatched: true,
      originalRectKeysMatched: false,
    },
  },
  {
    mode: "initial-extra",
    want: {
      ...unknownOriginalFacts,
      originalRectRecordMatched: true,
      originalRectKeysMatched: false,
    },
  },
  { mode: "initial-read-fault", want: unknownOriginalFacts },
])(
  "attributes the same initial SDK rectangle admission without another read: $mode",
  async ({ mode, want }) => {
    const f = await fixture(mode),
      source = NodeFS.readFileSync(
        new URL("../qualify-native-sharing.ts", import.meta.url),
        "utf8",
      );
    const init = source.indexOf("  const observation:"),
      initEnd = source.indexOf("  const step =", init);
    const facts = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(source.slice(init, initEnd)) + "\nobservation",
      {
        unknownNativeSharingOriginalRectFacts: Reflect.get(
          NativeViewport,
          "unknownNativeSharingOriginalRectFacts",
        ),
      },
    ) as Record<string, unknown>;
    const begin = source.indexOf('        step("native-original-size");'),
      end = source.indexOf('        step("native-initial-verification");', begin);
    const phases: string[] = [];
    let sdkError: unknown,
      failed = false,
      failure: unknown;
    const browser = Object.create(f.browser),
      read = f.browser.getWindowRect.bind(f.browser);
    Object.defineProperty(browser, "getWindowRect", {
      value: async () => {
        try {
          return await read();
        } catch (error) {
          sdkError = error;
          throw error;
        }
      },
    });
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes("(async()=>{" + source.slice(begin, end) + "})"),
      {
        browser,
        owner: f.owner,
        guard: () => {
          throw new Error("Unexpected additional identity read.");
        },
        verifyNativeSharingWindow: () => {},
        validateNativeSharingIdentity: () => {},
        collectNativeSharingIdentity: () => {},
        endpoint: {},
        descriptor: () => {},
        identity: {},
        createNativeSharingViewport,
        createNativeSharingGeometry: () => ({
          ...f.input.geometry,
          acquire: async () => ({ rectangle: await browser.getWindowRect() }),
        }),
        markUnsafe: f.input.unsafeCleanup,
        step: (phase: string) => phases.push(phase),
        observe: (next: object) => Object.assign(facts, next),
      },
    );
    try {
      await run();
    } catch (error) {
      failed = true;
      failure = error;
    }
    expect(failed).toBe(mode !== "owned");
    if (mode === "initial-read-fault") expect(failure).toBe(sdkError);
    else if (mode !== "owned")
      expect(failure).toMatchObject({ message: "Owned native sharing viewport refused." });
    expect(
      Object.fromEntries(Object.keys(unknownOriginalFacts).map((key) => [key, facts[key]])),
    ).toEqual(want);
    expect(phases.at(-1)).toBe(
      mode === "initial-read-fault" ? "native-original-size" : "native-original-rect-admission",
    );
    expect(f.gets()).toBe(1);
    expect(f.sets()).toBe(0);
    expect(f.unsafe()).toBe(0);
    expect(JSON.stringify(facts)).not.toContain("inert value");
  },
);
it.each(["proxy", "getter", "hidden", "extra-getter", "symbol", "missing", "array"])(
  "keeps unsafe original rectangle metadata passive and private: %s",
  async (mode) => {
    const f = await fixture(),
      original: Record<string, unknown> = { ...f.original };
    let reads = 0;
    const packets: unknown[] = [];
    if (mode === "getter" || mode === "hidden")
      Object.defineProperty(
        original,
        "width",
        mode === "getter"
          ? {
              enumerable: true,
              get: () => {
                reads++;
                throw new Error("Inert private getter.");
              },
            }
          : { enumerable: false, value: 1024 },
      );
    if (mode === "extra-getter")
      Object.defineProperty(original, "secret", {
        enumerable: true,
        get: () => {
          reads++;
          throw new Error("Inert extra getter.");
        },
      });
    if (mode === "symbol") original[Symbol("inert secret") as unknown as string] = "inert secret";
    if (mode === "missing") delete original.width;
    const value =
      mode === "proxy"
        ? new Proxy(original, {
            ownKeys: () => {
              reads++;
              throw new Error("Inert proxy trap.");
            },
            get: () => {
              reads++;
              throw new Error("Inert proxy trap.");
            },
          })
        : mode === "array"
          ? [original]
          : original;
    expect(() =>
      createNativeSharingViewport({
        ...f.input,
        original: value,
        onOriginalRectFacts: (facts: unknown) => packets.push(facts),
      }),
    ).toThrow("Owned native sharing viewport refused.");
    expect(packets).toHaveLength(1);
    expect(Object.keys(packets[0] as object).sort()).toEqual(
      Object.keys(unknownOriginalFacts).sort(),
    );
    expect(
      Object.values(packets[0] as object).every(
        (value) => value === null || typeof value === "boolean",
      ),
    ).toBe(true);
    expect(JSON.stringify(packets)).not.toMatch(/secret|width|height|1024|768|\/|</);
    expect(reads).toBe(0);
    expect(f.gets()).toBe(0);
    expect(f.sets()).toBe(0);
  },
);
it("does not let diagnostic failure or mutation change original admission", async () => {
  const f = await fixture(),
    sentinel = new Error("Inert diagnostic failure."),
    original = { x: 0, y: 0, width: 0, height: 0 };
  let packet: unknown;
  expect(() =>
    createNativeSharingViewport({
      ...f.input,
      original,
      onOriginalRectFacts: (facts: unknown) => {
        packet = facts;
        original.width = 1024;
        original.height = 768;
        throw sentinel;
      },
    }),
  ).toThrow("Owned native sharing viewport refused.");
  expect(packet).toMatchObject({ originalRectDimensionsPositive: false });
  const admitted = createNativeSharingViewport({
    ...f.input,
    onOriginalRectFacts: () => {
      throw sentinel;
    },
  });
  await admitted.restore();
  expect(f.rect()).toEqual(f.original);
  expect(f.unsafe()).toBe(0);
});
it("leaves unvisited original predicates unknown without another property inspection", async () => {
  const f = await fixture(),
    original = { ...f.original, width: 1024.5 };
  let packet: unknown,
    laterReads = 0;
  const descriptor = Object.getOwnPropertyDescriptor;
  const reflection = vi
    .spyOn(Object, "getOwnPropertyDescriptor")
    .mockImplementation((value, key) => {
      if (value === original && key === "height") laterReads++;
      return descriptor(value, key);
    });
  try {
    expect(() =>
      createNativeSharingViewport({
        ...f.input,
        original,
        onOriginalRectFacts: (facts: unknown) => {
          packet = facts;
        },
      }),
    ).toThrow("Owned native sharing viewport refused.");
    expect(packet).toMatchObject({
      originalRectNumbersFinite: null,
      originalRectNumbersInteger: false,
      originalRectDimensionsPositive: null,
    });
    expect(laterReads).toBe(0);
  } finally {
    reflection.mockRestore();
  }
});
it.each(["nonfinite", "last-fractional"])(
  "records only decidable original numeric predicates: %s",
  async (mode) => {
    const f = await fixture(),
      original = { ...f.original, height: mode === "nonfinite" ? Number.POSITIVE_INFINITY : 768.5 };
    let packet: unknown;
    expect(() =>
      createNativeSharingViewport({
        ...f.input,
        original,
        onOriginalRectFacts: (facts: unknown) => {
          packet = facts;
        },
      }),
    ).toThrow("Owned native sharing viewport refused.");
    expect(packet).toMatchObject(
      mode === "nonfinite"
        ? { originalRectNumbersFinite: false, originalRectNumbersInteger: null }
        : { originalRectNumbersFinite: true, originalRectNumbersInteger: false },
    );
    expect(f.gets()).toBe(0);
    expect(f.sets()).toBe(0);
  },
);
it("publishes immutable original facts from the same admitted snapshot under callback reentry", async () => {
  const f = await fixture(),
    original = { ...f.original };
  let packet: unknown,
    reentered = false;
  const viewport = createNativeSharingViewport({
    ...f.input,
    original,
    onOriginalRectFacts: (facts: unknown) => {
      packet = facts;
      expect(Object.isFrozen(facts)).toBe(true);
      original.width = -1;
      createNativeSharingViewport({ ...f.input, original: { ...f.original } });
      reentered = true;
    },
  });
  expect(reentered).toBe(true);
  expect(packet).toEqual(admittedOriginalFacts);
  expect(f.gets()).toBe(0);
  expect(f.sets()).toBe(0);
  await viewport.restore();
  expect(f.rect()).toEqual(f.original);
  expect(f.sets()).toBe(1);
});
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
      facts: Record<string, boolean | null> = {};
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
        observe: (value: Record<string, boolean | null>) => Object.assign(facts, value),
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

it.each([
  { mode: "owned", ack: true, frame: true },
  { mode: "native-restore-delayed", ack: true, frame: true },
  { mode: "native-restore-refusal", ack: false, frame: null },
  { mode: "native-restore-unsettled", ack: true, frame: false },
])(
  "attributes actual SDK restoration stages without altering errors or calls: $mode",
  async ({ mode, ack, frame }) => {
    const f = await fixture(mode),
      geometry = createNativeSharingGeometry({
        browser: f.browser,
        unsafeCleanup: f.input.unsafeCleanup,
      });
    const original = (await geometry.acquire()).rectangle;
    const viewport = createNativeSharingViewport({ ...f.input, original, geometry });
    await viewport.fit();
    let failed = false,
      error: unknown;
    try {
      await viewport.restore();
    } catch (value) {
      failed = true;
      error = value;
    }
    expect(f.facts).toMatchObject({
      viewportRestoreIdentityVerified: true,
      viewportRestoreCommandReturned: ack,
      viewportRestoreOriginalFrameMatched: frame,
    });
    expect(failed).toBe(!frame);
    expect(f.sets()).toBe(2);
    expect(f.gets()).toBe(0);
    if (frame) {
      expect(f.rect()).toEqual(f.original);
      expect(f.unsafe()).toBe(0);
      await expect(viewport.verify()).resolves.toBeUndefined();
    } else {
      expect(f.unsafe()).toBeGreaterThan(0);
      if (ack) expect(error).toBe(f.timeout);
      else
        expect(error).toMatchObject({
          name: "unknown error",
          message: expect.stringContaining("Inert native restoration refusal."),
        });
    }
  },
);
it.each(["error", "undefined"])(
  "retains the exact restoration identity failure and unreached stages: %s",
  async (mode) => {
    const f = await fixture(),
      original = mode === "undefined" ? undefined : new Error("Inert exact identity failure.");
    const viewport = createNativeSharingViewport({
      ...f.input,
      identity: async () => {
        throw original;
      },
    });
    let failed = false,
      failure: unknown;
    try {
      await viewport.restore();
    } catch (error) {
      failed = true;
      failure = error;
    }
    expect(failed).toBe(true);
    expect(failure).toBe(original);
    expect(f.facts).toMatchObject({
      viewportRestoreIdentityVerified: false,
      viewportRestoreCommandReturned: false,
      viewportRestoreOriginalFrameMatched: null,
      viewportRestoreFailed: true,
    });
    expect(f.sets()).toBe(0);
    expect(f.gets()).toBe(0);
    expect(f.unsafe()).toBe(1);
  },
);

it.each(["owned", "native-restore-refusal"])(
  "keeps restore observers passive and genuine SDK refusal primary: %s",
  async (mode) => {
    const f = await fixture(mode),
      geometry = createNativeSharingGeometry({
        browser: f.browser,
        unsafeCleanup: f.input.unsafeCleanup,
      });
    const original = (await geometry.acquire()).rectangle;
    const viewport = createNativeSharingViewport({
      ...f.input,
      original,
      geometry,
      observe: (facts) => {
        Object.assign(f.facts, facts);
        if (facts.viewportRestoreIdentityVerified) throw new Error("Inert diagnostic failure.");
      },
    });
    await viewport.fit();
    if (mode === "owned")
      await expect(viewport.restore()).rejects.toThrow("Owned native sharing viewport refused.");
    else
      await expect(viewport.restore()).rejects.toMatchObject({
        name: "unknown error",
        message: expect.stringContaining("Inert native restoration refusal."),
      });
    expect(f.unsafe()).toBeGreaterThan(0);
    expect(f.sets()).toBe(2);
    expect(f.gets()).toBe(0);
  },
);
it.each(["owned", "native-restore-refusal", "native-restore-unsettled"])(
  "the actual controller failure envelope retains original failure and restore stage facts: %s",
  async (mode) => {
    const f = await fixture(mode),
      geometry = createNativeSharingGeometry({
        browser: f.browser,
        unsafeCleanup: f.input.unsafeCleanup,
      });
    const viewport = createNativeSharingViewport({
      ...f.input,
      original: (await geometry.acquire()).rectangle,
      geometry,
    });
    const source = NodeFS.readFileSync(
      new URL("../qualify-native-sharing.ts", import.meta.url),
      "utf8",
    );
    const begin = source.indexOf("        let visualFailed"),
      end = source.indexOf("        if (captured.size", begin);
    const catchStart = source.indexOf(
        "  } catch (error) {\n    failed = true;\n    failure = error;",
      ),
      catchEnd = source.indexOf("  } finally {", catchStart);
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    expect(catchStart).toBeGreaterThan(end);
    const original = Object.freeze(
        new Error("The required live observation did not arrive within its bound."),
      ),
      envelope: object[] = [];
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "(async()=>{let failed=false,failure;try{" +
          source.slice(begin, end) +
          source.slice(catchStart, catchEnd) +
          "}return {failed,failure};})",
      ),
      {
        browser: f.browser,
        viewport,
        owner: f.owner,
        original: "tauri://localhost/#/settings/general",
        verify: viewport.verify,
        step: () => {},
        observe: () => {},
        markUnsafe: f.input.unsafeCleanup,
        evidence: "/inert/evidence",
        captured: new Set(),
        captures: [],
        write: (name: string, value: object) => {
          expect(name).toBe("failure");
          envelope.push(value);
        },
        withNativeSharingRoute: () => {},
        readNativeSharingRoute: () => {},
        routePorts: {},
        createNativeSharingBrowserPorts: async () => ({}),
        runNativeSharingVisual: async () => {
          throw original;
        },
        phase: "native-share-no-route-light",
        observation: f.facts,
        classifyQualificationFailure,
      },
    );
    const result = await run();
    expect(result.failed).toBe(true);
    expect(result.failure).toBe(original);
    expect(envelope).toHaveLength(1);
    expect(envelope[0]).toMatchObject({
      phase: "native-share-no-route-light",
      failure: { kind: "observation-timeout" },
      observation: {
        viewportRestoreIdentityVerified: true,
        viewportRestoreCommandReturned: mode !== "native-restore-refusal",
        viewportRestoreOriginalFrameMatched:
          mode === "owned" ? true : mode === "native-restore-refusal" ? null : false,
      },
    });
    expect(f.sets()).toBe(2);
    expect(f.gets()).toBe(0);
    expect(JSON.stringify(envelope)).not.toMatch(/Inert|tauri|private|\/inert/);
  },
);
