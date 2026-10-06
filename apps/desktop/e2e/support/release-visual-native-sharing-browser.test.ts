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
    execute: async (read: unknown, _input?: unknown) =>
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

function preparationProbe(fault = "owned", observer = "none") {
  const calls: string[] = [],
    phases: string[] = [],
    facts: Record<string, boolean> = {},
    original = new Error("Inert exact preparation failure."),
    restoreError = new Error("Inert exact restore failure.");
  let current = "tauri://localhost/#/settings/general",
    unsafe = false,
    navigations = 0;
  const browser = {
    getUrl: async () => {
      calls.push("url");
      if (fault === "url-read") throw original;
      return fault === "url-admission" ? "tauri://localhost/#/" : current;
    },
    url: async (value: string) => {
      calls.push("navigate");
      navigations++;
      if (fault === "navigation" && navigations === 1) throw original;
      if ((fault === "restore" || fault === "text-and-restore") && navigations === 2)
        throw restoreError;
      current = value;
    },
    $: () => {
      calls.push("query");
      return {
        waitForDisplayed: async () => {
          calls.push("display");
          if (fault === "display") throw original;
        },
        getText: async () => {
          calls.push("text");
          if (fault === "text" || fault === "text-and-restore") throw original;
          return fault === "label" ? "Inert private label" : "System";
        },
      };
    },
  };
  const input = {
    browser: browser as never,
    owner: {} as never,
    evidence: "/owned/evidence",
    captured: new Set<string>(),
    routeScope: async () => {},
    verifyRoute: async () => {},
    identity: async () => {},
    unsafeCleanup: () => {
      unsafe = true;
    },
    onPreparationStage: (phase: string) => {
      phases.push(phase);
      if (observer === "stage") throw new Error("Inert observer failure.");
    },
    onPreparationFacts: (next: object) => {
      Object.assign(facts, next);
      if (observer === "facts") throw new Error("Inert observer failure.");
    },
  };
  return {
    input,
    calls,
    phases,
    facts,
    original,
    restoreError,
    unsafe: () => unsafe,
    current: () => current,
  };
}
it.each([
  ["url-read", "native-ui-ports-url-read", ["url"]],
  ["url-admission", "native-ui-ports-url-admission", ["url"]],
  ["navigation", "native-ui-ports-general-navigate", ["url", "navigate", "navigate"]],
  ["display", "native-ui-ports-theme-display", ["url", "navigate", "query", "display", "navigate"]],
  [
    "text",
    "native-ui-ports-theme-text",
    ["url", "navigate", "query", "display", "text", "navigate"],
  ],
  [
    "label",
    "native-ui-ports-theme-admission",
    ["url", "navigate", "query", "display", "text", "navigate"],
  ],
  [
    "restore",
    "native-ui-ports-original-restore",
    ["url", "navigate", "query", "display", "text", "navigate"],
  ],
])(
  "attributes the actual preparation %s seam without adding an action",
  async (fault, phase, calls) => {
    const p = preparationProbe(fault as string);
    const result = createNativeSharingBrowserPorts(p.input);
    if (fault === "restore") await expect(result).rejects.toBe(p.restoreError);
    else if (fault === "url-admission" || fault === "label") await expect(result).rejects.toThrow();
    else await expect(result).rejects.toBe(p.original);
    expect(p.phases.at(-1)).toBe(phase);
    expect(p.calls).toEqual(calls);
    expect(Object.values(p.facts).every((value) => typeof value === "boolean")).toBe(true);
    expect(JSON.stringify(p.facts)).not.toMatch(/tauri|localhost|Inert private label/);
  },
);
it("returns preparation facts from the existing reads and restores the same original", async () => {
  const p = preparationProbe();
  await createNativeSharingBrowserPorts(p.input);
  expect(p.phases).toEqual([
    "native-ui-ports-url-read",
    "native-ui-ports-url-admission",
    "native-ui-ports-general-navigate",
    "native-ui-ports-theme-display",
    "native-ui-ports-theme-text",
    "native-ui-ports-theme-admission",
    "native-ui-ports-original-restore",
  ]);
  expect(p.calls).toEqual(["url", "navigate", "query", "display", "text", "navigate"]);
  expect(p.facts).toMatchObject({
    uiPortsUrlReturned: true,
    uiPortsUrlProtocolMatched: true,
    uiPortsUrlHostMatched: true,
    uiPortsUrlAuthorityClean: true,
    uiPortsUrlRootPathMatched: true,
    uiPortsUrlQueryClean: true,
    uiPortsUrlRouteAllowed: true,
    uiPortsGeneralNavigated: true,
    uiPortsThemeDisplayed: true,
    uiPortsThemeTextReturned: true,
    uiPortsThemeLabelAllowed: true,
    uiPortsThemeLabelSystem: true,
    uiPortsThemeLabelLight: false,
    uiPortsThemeLabelDark: false,
    uiPortsOriginalRestoreAttempted: true,
    uiPortsOriginalRestored: true,
  });
  expect(p.facts.uiPortsOriginalRestoreFailed).toBeUndefined();
  expect(p.current()).toBe("tauri://localhost/#/settings/general");
  expect(p.unsafe()).toBe(false);
});
it("preserves the earlier preference exception and its phase when original restoration also fails", async () => {
  const p = preparationProbe("text-and-restore");
  await expect(createNativeSharingBrowserPorts(p.input)).rejects.toBe(p.original);
  expect(p.phases.at(-1)).toBe("native-ui-ports-theme-text");
  expect(p.facts.uiPortsOriginalRestoreAttempted).toBe(true);
  expect(p.facts.uiPortsOriginalRestoreFailed).toBe(true);
  expect(p.unsafe()).toBe(true);
});
it.each(["stage", "facts"])(
  "refuses false preparation success after a failed %s observer",
  async (observer) => {
    const p = preparationProbe("owned", observer);
    await expect(createNativeSharingBrowserPorts(p.input)).rejects.toThrow();
    expect(p.calls).toEqual(["url", "navigate", "query", "display", "text", "navigate"]);
    expect(p.unsafe()).toBe(true);
  },
);
it.each(["stage", "facts"])(
  "preserves genuine preference/restore errors after a failed %s observer",
  async (observer) => {
    const p = preparationProbe("text-and-restore", observer);
    await expect(createNativeSharingBrowserPorts(p.input)).rejects.toBe(p.original);
    expect(p.phases.at(-1)).toBe("native-ui-ports-theme-text");
    expect(p.facts.uiPortsOriginalRestoreFailed).toBe(true);
    expect(p.unsafe()).toBe(true);
  },
);

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
