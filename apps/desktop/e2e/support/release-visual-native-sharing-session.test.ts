import { afterEach, expect, it, vi } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off - Actual controller fragments execute only on inert ownership/SDK ports.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { closeNativeSharingSession, verifyNativeSharingWindow } from "../qualify-native-sharing.ts";
import { withNativeSharingApplication } from "./release-visual-native-sharing-application.ts";
afterEach(() => vi.unstubAllGlobals());
function fixture(mode = "owned") {
  const calls: string[] = [],
    prepareError = new Error("Inert native prepare failure."),
    deleteError = new Error("Inert session delete failure.");
  let deleted = false;
  vi.stubGlobal(
    "window",
    mode === "missing-bridge"
      ? {}
      : {
          __TAURI__: {
            core: {
              invoke: async (command: string) => {
                calls.push(command);
                if (mode === "prepare-failure" || mode === "both-fail") throw prepareError;
              },
            },
          },
        },
  );
  const browser = {
    execute: async (read: () => Promise<unknown>) => read(),
    deleteSession: async () => {
      calls.push("deleteSession");
      deleted = true;
      if (mode === "delete-failure" || mode === "both-fail") throw deleteError;
    },
  };
  return { browser, calls, prepareError, deleteError, deleted: () => deleted };
}
it("joins the real native preparation callback before deleting the still-live driver session", async () => {
  const f = fixture();
  await closeNativeSharingSession(f.browser as never);
  expect(f.calls).toEqual(["desktop_e2e_prepare_for_exit", "deleteSession"]);
});
it.each(["prepare-failure", "delete-failure", "both-fail", "missing-bridge"])(
  "still joins session deletion and refuses unsafe native cleanup: %s",
  async (mode) => {
    const f = fixture(mode);
    await expect(closeNativeSharingSession(f.browser as never)).rejects.toThrow();
    expect(f.deleted()).toBe(true);
    if (mode === "prepare-failure" || mode === "both-fail")
      await expect(closeNativeSharingSession(f.browser as never)).rejects.toBe(f.prepareError);
  },
);
it("prepares the backend on a connected visual failure while preserving that original failure", async () => {
  const f = fixture(),
    original = new Error("Inert visual failure.");
  let stopped = false;
  await expect(
    withNativeSharingApplication(
      {
        guard: async () => {},
        start: async () => {},
        connect: async () => f.browser,
        disconnect: (browser) => closeNativeSharingSession(browser as never),
        stop: async () => {
          stopped = true;
        },
        unsafeCleanup: () => {},
      },
      async () => {
        throw original;
      },
    ),
  ).rejects.toBe(original);
  expect(f.calls).toEqual(["desktop_e2e_prepare_for_exit", "deleteSession"]);
  expect(stopped).toBe(true);
});
it.each(["extra", "current", "duplicate", "missing"])(
  "refuses changed native window identity at a later capture check: %s",
  async (mode) => {
    let changed = false;
    const browser = {
      getWindowHandles: async () =>
        changed
          ? mode === "extra"
            ? ["main", "preview"]
            : mode === "duplicate"
              ? ["main", "main"]
              : mode === "missing"
                ? []
                : ["main"]
          : ["main"],
      getWindowHandle: async () => (changed && mode === "current" ? "preview" : "main"),
    };
    await verifyNativeSharingWindow(browser);
    changed = true;
    await expect(verifyNativeSharingWindow(browser)).rejects.toThrow();
  },
);
function admissionProbe(fault = "owned") {
  const source = NodeFS.readFileSync(
      new NodeURL.URL("../qualify-native-sharing.ts", import.meta.url),
      "utf8",
    ),
    begin = source.indexOf('        step("native-bridge-ready");'),
    end = source.indexOf("        let visualFailed", begin);
  expect(begin).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(begin);
  const phases: string[] = [],
    facts: Record<string, boolean> = {},
    calls: string[] = [];
  const original = new Error("Inert exact admission failure.");
  const bridge = { metadata: { host: "tauri" }, endpoint: "http://127.0.0.1:3773" };
  const browser = {
    getWindowHandles: async () => {
      calls.push("handles");
      return fault === "handles" ? ["main", "other"] : ["main"];
    },
    getWindowHandle: async () => {
      calls.push("current");
      return fault === "current" ? "other" : "main";
    },
    execute: async () => {
      calls.push("bridge");
      return fault === "endpoint" ? { ...bridge, endpoint: "https://foreign.invalid" } : bridge;
    },
    getUrl: async () => {
      calls.push("url");
      if (fault === "url") throw original;
      return "tauri://localhost/";
    },
    getWindowRect: async () => {
      calls.push("size");
      return { x: 0, y: 0, width: 1280, height: 960 };
    },
  };
  const collect = async (input: { descriptor: () => Promise<unknown> }) => {
    if (fault === "identity-read") throw original;
    return { metadata: bridge.metadata, descriptor: await input.descriptor() };
  };
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes("(async()=>{" + source.slice(begin, end) + "})"),
    {
      browser,
      step: (phase: string) => phases.push(phase),
      observe: (next: Record<string, boolean>) => Object.assign(facts, next),
      markUnsafe: () => {},
      guard: async () => {},
      owner: {
        until: async (check: () => Promise<boolean>) => {
          expect(await check()).toBe(true);
        },
      },
      createNativeSharingViewport: (input: { identity: () => Promise<void> }) => ({
        verify: input.identity,
      }),
      createNativeSharingGeometry: () => ({
        acquire: async () => ({ rectangle: await browser.getWindowRect() }),
      }),
      readNativeSharingBridge: () => {},
      collectNativeSharingIdentity: collect,
      verifyNativeSharingWindow: async () => {
        calls.push("verify-window");
      },
      validateNativeSharingIdentity: () => {
        calls.push("validate");
        if (fault === "identity-check") throw original;
      },
      fetch: async () => ({
        ok: fault !== "descriptor-http",
        json: async () => ({ bootId: "owned", storageInstanceId: "owned", serverVersion: "owned" }),
      }),
      EnvironmentMetadataHttpApi: { endpoints: { descriptor: { path: "/descriptor" } } },
      URL,
      AbortSignal,
      refused: () => original,
    },
  );
  return { run, phases, facts, calls, original };
}
it.each([
  "handles",
  "current",
  "endpoint",
  "identity-read",
  "descriptor-http",
  "identity-check",
  "url",
])(
  "attributes the actual admission await/check and retains its original exception: %s",
  async (fault) => {
    const p = admissionProbe(fault);
    await expect(p.run()).rejects.toBe(p.original);
    const expected: Record<string, string> = {
      handles: "native-window-handles",
      current: "native-window-current",
      endpoint: "native-endpoint-admission",
      "identity-read": "native-initial-identity-read",
      "descriptor-http": "native-initial-descriptor",
      "identity-check": "native-initial-verification",
      url: "native-original-url",
    };
    expect(p.phases.at(-1)).toBe(expected[fault]);
    expect(Object.values(p.facts).every((value) => typeof value === "boolean")).toBe(true);
  },
);
it("records closed facts from existing reads without adding a native admission call", async () => {
  const p = admissionProbe();
  await p.run();
  expect(p.facts.windowMainOnly).toBe(true);
  expect(p.facts.bridgeReady).toBe(true);
  expect(p.facts.descriptorResponseOk).toBe(true);
  expect(p.calls).toEqual([
    "handles",
    "current",
    "bridge",
    "bridge",
    "url",
    "size",
    "verify-window",
    "validate",
  ]);
});
it("keeps cleanup facts separate and observational errors from replacing the original failure", async () => {
  const f = fixture("both-fail"),
    facts: Record<string, boolean> = {};
  await expect(
    closeNativeSharingSession(f.browser as never, (next) => {
      Object.assign(facts, next);
      throw new Error("Inert observer failure.");
    }),
  ).rejects.toBe(f.prepareError);
  expect(facts.cleanupPrepareFailed).toBe(true);
  expect(facts.cleanupSessionDeleteFailed).toBe(true);
  expect(f.calls).toEqual(["desktop_e2e_prepare_for_exit", "deleteSession"]);
});
it.each(["size", "navigation", "settlement", "ports"])(
  "attributes actual UI setup failures at their native boundary: %s",
  async (fault) => {
    const source = NodeFS.readFileSync(
        new NodeURL.URL("../qualify-native-sharing.ts", import.meta.url),
        "utf8",
      ),
      begin = source.indexOf('          step("native-ui-window-size");'),
      end = source.indexOf('          step("native-sharing-scenes");', begin);
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    const phases: string[] = [],
      calls: string[] = [],
      original = new Error("Inert exact UI setup failure.");
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes("(async()=>{" + source.slice(begin, end) + "})"),
      {
        step: (phase: string) => phases.push(phase),
        observe: () => {},
        viewport: {
          fit: async () => {
            calls.push("size");
            if (fault === "size") throw original;
          },
        },
        browser: {
          url: async () => {
            calls.push("navigation");
            if (fault === "navigation") throw original;
          },
          getUrl: async () => "tauri://localhost/#/settings/general",
        },
        createNativeSharingBrowserPorts: async () => {
          calls.push("ports");
          if (fault === "ports") throw original;
          return {};
        },
        owner: {
          until: async (check: () => Promise<boolean>) => {
            calls.push("settlement");
            if (fault === "settlement") throw original;
            expect(await check()).toBe(true);
          },
        },
        evidence: "private",
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
    await expect(run()).rejects.toBe(original);
    expect(phases.at(-1)).toBe(
      fault === "size"
        ? "native-ui-window-size"
        : fault === "navigation"
          ? "native-ui-navigation"
          : fault === "settlement"
            ? "native-ui-navigation-settle"
            : "native-ui-ports",
    );
    expect(calls).toEqual(
      fault === "size"
        ? ["size"]
        : fault === "navigation"
          ? ["size", "navigation"]
          : fault === "settlement"
            ? ["size", "navigation", "settlement"]
            : ["size", "navigation", "settlement", "ports"],
    );
  },
);
