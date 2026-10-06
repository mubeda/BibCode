// @effect-diagnostics nodeBuiltinImport:off - Synthetic PNG and private TempFS exercise actual capture wiring only.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { expect, it } from "vite-plus/test";
import { createNativeSharingBrowserPorts } from "./release-visual-native-sharing-browser.ts";
import type { NativeSharingRouteScope } from "./release-visual-native-sharing-route.ts";
function fixture(mode = "owned") {
  const calls: string[] = [];
  let current = "tauri://localhost/#/local/owned",
    dark = false;
  const browser = {
    getUrl: async () => current,
    url: async (value: string) => {
      current = value;
      calls.push("navigate");
    },
    $$: () =>
      mode === "query-promise"
        ? Promise.resolve([{}])
        : { length: Promise.resolve(mode === "duplicate" ? 2 : 1) },
    $: (selector: string) => ({
      waitForDisplayed: async () => {},
      waitForEnabled: async () => {},
      isFocused: async () => true,
      getText: async () => {
        if (mode === "preference-failure") throw new Error("Inert preference read failure.");
        return "System";
      },
      click: async () => {
        calls.push(selector);
        if (selector.includes('normalize-space()="Dark"')) dark = true;
        if (selector.includes('normalize-space()="Light"')) dark = false;
      },
    }),
    execute: async (read: unknown, input?: unknown) =>
      String(read).includes("location.origin")
        ? { origin: "tauri://localhost", hash: "#/local/owned", theme: "System" }
        : true,
    getWindowSize: async () => ({ width: 1280, height: 960 }),
    setWindowSize: async () => {},
    isAlertOpen: async () => false,
  };
  const input = {
    browser: browser as never,
    owner: {
      until: async (check: () => Promise<boolean>) => {
        expect(await check()).toBe(true);
      },
    } as never,
    evidence: "/owned/evidence",
    captured: new Set<string>(),
    routeScope: async (run: (scope: NativeSharingRouteScope) => Promise<void>) =>
      run({ kind: "native-sharing-private-route", restore: async () => {} }),
    verifyRoute: async () => {},
    identity: async () => {
      calls.push("identity");
    },
    capture: async () => {
      calls.push("capture");
    },
    unsafeCleanup: () => {
      calls.push("unsafe");
    },
  };
  return { input, browser, calls, dark: () => dark, current: () => current };
}
it("uses only actual public settings/theme/share/Refresh controls and restores original route/theme", async () => {
  const f = fixture(),
    ports = await createNativeSharingBrowserPorts(f.input);
  await ports.theme("dark");
  await ports.openShare();
  await ports.refresh();
  await ports.restoreOriginal();
  expect(f.calls).toContain('button[aria-label="Refresh addresses"]');
  expect(f.calls).toContain('//*[@role="tab" and normalize-space()="Share this host"]');
  expect(f.current()).toBe("tauri://localhost/#/local/owned");
  expect(f.calls.some((value) => value.includes('normalize-space()="System"'))).toBe(true);
});
it("refuses duplicate public controls before a click", async () => {
  const f = fixture("duplicate"),
    ports = await createNativeSharingBrowserPorts(f.input);
  await expect(ports.refresh()).rejects.toThrow();
  expect(f.calls).not.toContain('button[aria-label="Refresh addresses"]');
});
it("awaits the public element query before reading its resolved cardinality", async () => {
  const f = fixture("query-promise"),
    ports = await createNativeSharingBrowserPorts(f.input);
  await ports.refresh();
  expect(f.calls).toContain('button[aria-label="Refresh addresses"]');
});

it("restores the original route when construction's public preference read fails", async () => {
  const f = fixture("preference-failure");
  await expect(createNativeSharingBrowserPorts(f.input)).rejects.toThrow(
    "Inert preference read failure.",
  );
  expect(f.current()).toBe("tauri://localhost/#/local/owned");
});

function syntheticCaptureBytes() {
  const chunk = (name: string, data: Buffer) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length);
    out.write(name, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(NodeZlib.crc32(out.subarray(4, out.length - 4)), out.length - 4);
    return out;
  };
  const width = 1280,
    height = 960,
    header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const n = y * (width * 3 + 1) + 1 + x * 3;
      rows[n] = x < 640 ? 200 : 20;
      rows[n + 1] = 40;
      rows[n + 2] = x < 640 ? 20 : 200;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
it.each(["owned", "post-image-drift"])(
  "uses the shared original-byte capture with native source/route proof before and after image: %s",
  async (mode) => {
    const f = fixture(),
      evidence = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "native-sharing-capture-")),
      bytes = syntheticCaptureBytes();
    const receipts: Readonly<Record<string, unknown>>[] = [];
    let shot = false,
      scoped: (() => Promise<void>) | undefined;
    const input = {
      ...f.input,
      evidence,
      onCapture: (receipt: Readonly<Record<string, unknown>>) => {
        receipts.push(receipt);
      },
      browser: {
        ...f.browser,
        isAlertOpen: async () => false,
        takeScreenshot: async () => {
          shot = true;
          f.calls.push("screenshot");
          return bytes.toString("base64");
        },
        execute: async () => ({
          routeMatched: true,
          themeMatched: true,
          shareSelected: true,
          controlsMatched: true,
          expectedState: true,
          credentialAbsent: true,
          targetInView: true,
        }),
      } as never,
      identity: async () => {
        f.calls.push("identity");
        if (mode === "post-image-drift" && shot) throw new Error("Inert changed native identity.");
      },
      routeScope: async (run: (scope: NativeSharingRouteScope) => Promise<void>) =>
        run({ kind: "native-sharing-private-route", restore: async () => {} }),
      verifyRoute: async () => {
        f.calls.push("route-proof");
      },
    };
    try {
      const ports = await createNativeSharingBrowserPorts(input);
      await ports.withMissingRoute(async (scope) => {
        await ports.verifyRoute(scope, "absent");
        scoped = () => ports.capture("native-share-no-route", "light");
        if (mode === "owned") await scoped();
        else await expect(scoped()).rejects.toThrow("Inert changed native identity.");
      });
      const path = NodePath.join(evidence, "native-share-no-route-light.png");
      expect(NodeFS.existsSync(path)).toBe(mode === "owned");
      if (mode === "owned") expect(NodeFS.readFileSync(path).equals(bytes)).toBe(true);
      expect(receipts).toHaveLength(mode === "owned" ? 1 : 0);
      if (mode === "owned")
        expect(receipts[0]).toMatchObject({
          file: "native-share-no-route-light.png",
          scene: "native-share-no-route",
          theme: "light",
          width: 1280,
          height: 960,
          witness: {
            routeMatched: true,
            themeMatched: true,
            shareSelected: true,
            controlsMatched: true,
            expectedState: true,
            credentialAbsent: true,
            targetInView: true,
          },
        });
      expect(f.calls.lastIndexOf("identity")).toBeGreaterThan(f.calls.indexOf("screenshot"));
      await expect(scoped!()).rejects.toThrow();
    } finally {
      NodeFS.rmSync(evidence, { recursive: true, force: true });
    }
  },
);
