import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";

import {
  browserStartupObservationScript,
  projectBrowserStartupObservation,
} from "./browser-startup.ts";

function install(resourceObserverAvailable = true) {
  const handlers = new Map<string, (event: unknown) => void>();
  let resources!: (list: { getEntries: () => unknown[] }) => void;
  const elements = new Set(["boot-shell"]);
  const page: Record<string, unknown> = {};
  const document = {
    readyState: "loading",
    getElementById: (id: string) => (elements.has(id) ? {} : null),
    querySelector: (_selector: string) => null,
    querySelectorAll: (_selector: string) => [],
  };
  NodeVM.runInNewContext(browserStartupObservationScript, {
    window: page,
    document,
    location: { origin: "http://localhost:4901" },
    URL,
    addEventListener: (name: string, handler: (event: unknown) => void) =>
      handlers.set(name, handler),
    PerformanceObserver: class {
      constructor(callback: typeof resources) {
        resources = callback;
      }
      observe() {
        if (!resourceObserverAvailable) throw new Error("owned unavailable observer");
      }
    },
  });
  return {
    handlers,
    elements,
    document,
    resource: (entries: unknown[]) => resources({ getEntries: () => entries }),
    failedResourceRead: () =>
      resources({
        getEntries: () => {
          throw new Error("private-secret");
        },
      }),
    read: () => (page.__browserStartupObservation as { read(): unknown }).read(),
  };
}

describe("passive browser startup evidence", () => {
  it("observes boot and load independently without forcing readiness", () => {
    const fixture = install();
    expect(fixture.read()).toMatchObject({
      installed: true,
      bootShellPresent: true,
      domContentLoaded: false,
      windowLoaded: false,
    });
    fixture.handlers.get("DOMContentLoaded")?.({});
    fixture.handlers.get("load")?.({});
    expect(fixture.read()).toMatchObject({
      bootShellPresent: true,
      domContentLoaded: true,
      windowLoaded: true,
    });
    fixture.elements.delete("boot-shell");
    expect(fixture.read()).toMatchObject({ bootShellPresent: false });
  });

  it("projects resource completion without retaining names, URLs, query or private data", () => {
    const fixture = install();
    fixture.resource([
      {
        name: "http://localhost:4901/src/main.tsx?private-resource-secret",
        responseStatus: 200,
        duration: 1.234,
      },
      { name: "http://localhost:4901/src/bootstrap.tsx", responseStatus: 504, duration: 34 },
      {
        name: "http://localhost:4901/node_modules/.vite/deps/private-secret.js?v=secret",
        responseStatus: 200,
        duration: 40,
      },
      { name: "https://unowned.invalid/private-secret", responseStatus: 500, duration: 3 },
    ]);
    const observed = projectBrowserStartupObservation(fixture.read());
    expect(observed).toMatchObject({
      resourceObserverAvailable: true,
      resources: {
        entry: { completed: 1, lastStatus: "ok", lastDurationMs: 1 },
        bootstrap: { completed: 1, lastStatus: "server-error", lastDurationMs: 34 },
        optimized: { completed: 1, lastStatus: "ok", lastDurationMs: 40 },
      },
    });
    expect(JSON.stringify(observed)).not.toMatch(/private|secret|https?:\/\/|\.tsx/);
  });

  it("keeps only closed error classes and fixed module-failure markers", () => {
    const fixture = install();
    fixture.handlers.get("error")?.({
      error: { name: "SyntaxError", message: "credential-secret" },
      filename: "private-url",
    });
    fixture.handlers.get("unhandledrejection")?.({
      reason: {
        name: "TypeError",
        message: "Failed to fetch dynamically imported module: private-secret",
      },
    });
    fixture.handlers.get("error")?.({ target: { tagName: "SCRIPT", src: "private-secret" } });
    fixture.handlers.get("unhandledrejection")?.({
      reason: { name: "private-secret", message: "private-secret" },
    });
    const observed = projectBrowserStartupObservation(fixture.read());
    expect(observed).toMatchObject({
      errors: 1,
      rejections: 2,
      resourceErrors: 1,
      lastErrorClass: null,
      dynamicImportFailure: true,
    });
    expect(JSON.stringify(observed)).not.toMatch(/private|secret|credential/);
  });

  it("retains observed HTTP failures when a later resource in the same bucket succeeds", () => {
    const fixture = install();
    fixture.resource([
      {
        name: "http://localhost:4901/node_modules/.vite/deps/first.js",
        responseStatus: 504,
        duration: 5,
      },
      {
        name: "http://localhost:4901/node_modules/.vite/deps/second.js",
        responseStatus: 200,
        duration: 2,
      },
    ]);
    expect(projectBrowserStartupObservation(fixture.read())).toMatchObject({
      resources: { optimized: { completed: 2, httpErrors: 1 } },
    });
  });

  it("bounds resource work and reports partial coverage", () => {
    const fixture = install();
    fixture.resource(
      Array.from({ length: 300 }, () => ({
        name: "http://localhost:4901/src/main.tsx",
        responseStatus: 0,
        duration: Infinity,
      })),
    );
    expect(projectBrowserStartupObservation(fixture.read())).toMatchObject({
      resourceEntriesTruncated: true,
      resources: { entry: { completed: 256, lastStatus: "unknown", lastDurationMs: null } },
    });
  });

  it("keeps failed and unsupported observation distinct from zero resources", () => {
    const unsupported = install(false);
    expect(projectBrowserStartupObservation(unsupported.read())).toMatchObject({
      installed: true,
      resourceObserverAvailable: false,
      resources: { entry: null },
    });
    const failed = install();
    expect(() => failed.failedResourceRead()).not.toThrow();
    expect(projectBrowserStartupObservation(failed.read())).toMatchObject({
      resourceEntriesTruncated: true,
    });
  });

  it("saturates error counters without retaining payloads or suppressing page errors", () => {
    const fixture = install();
    let suppressed = 0;
    const event = {
      error: { name: "TypeError", message: "private-secret" },
      preventDefault: () => {
        suppressed++;
      },
    };
    for (let index = 0; index < 20_002; index++) fixture.handlers.get("error")?.(event);
    expect(projectBrowserStartupObservation(fixture.read())).toMatchObject({
      errors: 20_000,
      counterSaturated: true,
    });
    expect(JSON.stringify(fixture.read())).not.toContain("secret");
    expect(suppressed).toBe(0);
  });

  it("keeps unavailable and malicious input unknown instead of inventing measurements", () => {
    expect(projectBrowserStartupObservation(null)).toMatchObject({
      installed: null,
      bootShellPresent: null,
      errors: null,
      resources: { entry: null },
    });
    const observed = projectBrowserStartupObservation({
      installed: "true",
      bootShellPresent: [],
      errors: Infinity,
      rejections: -1,
      lastErrorClass: "TypeError-secret",
      resourceObserverAvailable: true,
      resources: {
        entry: { completed: NaN, lastStatus: "private-secret", lastDurationMs: Infinity },
        private: "secret",
      },
      credential: "secret",
    });
    expect(observed).toMatchObject({
      installed: null,
      bootShellPresent: null,
      errors: null,
      rejections: null,
      lastErrorClass: null,
      resources: { entry: { completed: null, lastStatus: null, lastDurationMs: null } },
    });
    expect(JSON.stringify(observed)).not.toMatch(/private|secret|credential/);
  });
});
