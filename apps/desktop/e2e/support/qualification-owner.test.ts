// @effect-diagnostics nodeBuiltinImport:off - Unit tests own disposable process fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import * as NodeModule from "node:module";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  QualificationOwner,
  ownedBrowserOptions,
  projectOwnedDriverReadiness,
} from "./qualification-owner.ts";
import { bindOwnedBrowserAlertObservation } from "./owned-browser-alert.ts";
import {
  prepareNetworkBeforeBrowser,
  verifyPreparedBrowserOnline,
  readNetworkCommandResult,
  NetworkSetupFailure,
  BrowserConnectivityFailure,
} from "./browser-network.ts";

const roots: string[] = [];
function owner() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-qa-owner-"));
  roots.push(root);
  return new QualificationOwner(root, root);
}
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

function driverReadinessReplay(
  outcomes: string[],
  observerMode: "none" | "record" | "throw" = "record",
) {
  const source = NodeFS.readFileSync(new URL("./qualification-owner.ts", import.meta.url), "utf8");
  const start = source.indexOf("export interface OwnedDriverReadiness");
  const end = source.indexOf("export async function openOwnedBrowser", start);
  const snapshots: unknown[] = [],
    requests: unknown[] = [],
    spawn: unknown[] = [],
    reads: boolean[] = [],
    bounds: number[] = [];
  let statusReads = 0,
    privateErrorReads = 0;
  const originalFailure = new Error("Inert original readiness deadline.");
  const child = {
    child: { exitCode: null as number | null, signalCode: null as string | null },
    spawnFailure: null as object | null,
  };
  const owner = {
    spawn: (...args: unknown[]) => {
      spawn.push(args);
      return child;
    },
    until: async (...args: [read: () => Promise<boolean>]) => {
      expect(args).toHaveLength(1);
      for (const outcome of outcomes) {
        current = outcome;
        const matched = await args[0]();
        reads.push(matched);
        if (matched) return;
      }
      throw originalFailure;
    },
  };
  let current = "";
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(source.slice(start, end)).replace(/^export /gm, "") +
      "\nstartOwnedBrowserDriver",
    {
      process: { env: { owned: true } },
      DOMException,
      AbortSignal: {
        timeout: (ms: number) => {
          bounds.push(ms);
          return { timeout: ms };
        },
      },
      fetch: async (url: string, options: unknown) => {
        requests.push({ url, options });
        if (current === "fetch-error") throw new TypeError("private URL/path/token fetch failure");
        if (current === "private-error") {
          const error = {};
          for (const key of ["name", "message", "code"])
            Object.defineProperty(error, key, {
              get: () => {
                privateErrorReads++;
                throw new Error("private error getter");
              },
            });
          throw error;
        }
        if (current === "proxy-error") {
          const error = Proxy.revocable({}, {});
          error.revoke();
          throw error.proxy;
        }
        if (current === "abort-error") throw new DOMException("private fetch error", "AbortError");
        const response = {
          ok: current !== "refused",
          status: current === "refused" ? 503 : 200,
          json: async () => {
            if (current === "invalid-json") throw new SyntaxError("private status body");
            if (current === "body-error") throw new Error("private decode error");
            if (current === "malformed") return { value: { ready: "private-ready-value" } };
            if (current === "null-body") return null;
            if (current === "ready-getter")
              return {
                value: {
                  get ready() {
                    throw new RangeError("private predicate error");
                  },
                },
              };
            return { value: { ready: current === "ready" || current === "status-getter" } };
          },
        };
        Object.defineProperty(response, "status", {
          get: () => {
            statusReads++;
            if (current === "status-getter") throw new Error("private status getter");
            return (
              (
                {
                  refused: 503,
                  "client-status": 404,
                  "redirect-status": 302,
                  "other-status": 101,
                  "invalid-status": Infinity,
                } as Record<string, number>
              )[current] ?? 200
            );
          },
        });
        return response;
      },
    },
  ) as (
    owner: unknown,
    driver: string,
    origin: string,
    observe?: (value: unknown) => void,
  ) => Promise<unknown>;
  return {
    run: () =>
      run(
        owner,
        "/owned/driver",
        "http://127.0.0.1:4885",
        observerMode === "none"
          ? undefined
          : (value) => {
              snapshots.push(value);
              if (observerMode === "throw") throw new Error("private observer error");
            },
      ),
    snapshots,
    requests,
    reads,
    spawn,
    bounds,
    child,
    originalFailure,
    statusReads: () => statusReads,
    privateErrorReads: () => privateErrorReads,
  };
}

describe("existing owned driver status read", () => {
  it.each(["none", "record", "throw"] as const)(
    "keeps the same predicate, requests, launch and bounds with observer=%s",
    async (mode) => {
      const outcomes = [
        "fetch-error",
        "refused",
        "invalid-json",
        "body-error",
        "malformed",
        "null-body",
        "ready-getter",
        "not-ready",
        "ready",
      ];
      const f = driverReadinessReplay(outcomes, mode);
      await expect(f.run()).resolves.toBe(f.child);
      expect(f.reads).toEqual([false, false, false, false, false, false, false, false, true]);
      expect(f.requests).toHaveLength(outcomes.length);
      expect(f.bounds).toEqual(outcomes.map(() => 1000));
      expect(f.spawn).toEqual([
        [
          "/owned/driver",
          ["--port=4915", "--allowed-ips=127.0.0.1", "--allowed-origins=http://127.0.0.1:4885"],
          { owned: true },
          "driver",
        ],
      ]);
      expect(
        f.requests.every(
          (value) =>
            JSON.stringify(value) ===
            JSON.stringify({
              url: "http://127.0.0.1:4915/status",
              options: { signal: { timeout: 1000 } },
            }),
        ),
      ).toBe(true);
      expect(f.statusReads()).toBe(mode === "none" ? 0 : outcomes.length - 1);
      if (mode !== "none") {
        expect(f.snapshots.at(-1)).toMatchObject({
          attempts: 9,
          attemptsCapped: false,
          lastHttpStatus: "success",
          ready: true,
          body: "decoded",
          failure: null,
          errorClass: null,
          driverExited: false,
          driverSpawn: "none",
        });
        expect(f.snapshots[0]).toMatchObject({ failure: "fetch", errorClass: "TypeError" });
        expect(f.snapshots[1]).toMatchObject({ lastHttpStatus: "server-error", body: "not-read" });
        expect(f.snapshots[2]).toMatchObject({ body: "invalid-json", errorClass: "SyntaxError" });
        expect(JSON.stringify(f.snapshots)).not.toMatch(/private|4915|4885|owned|http|token|path/);
      }
    },
  );
  it.each(["record", "throw"] as const)(
    "preserves original owner failure with observer=%s and reports existing driver facts",
    async (mode) => {
      const f = driverReadinessReplay(["not-ready"], mode);
      f.child.child.exitCode = 7;
      f.child.spawnFailure = { private: "never copied" };
      await expect(f.run()).rejects.toBe(f.originalFailure);
      expect(f.snapshots.at(-1)).toMatchObject({
        attempts: 1,
        ready: false,
        driverExited: true,
        driverSpawn: "failed",
      });
      expect(f.requests).toHaveLength(1);
    },
  );
  it("quarantines the optional status getter while preserving the original ready response", async () => {
    const f = driverReadinessReplay(["status-getter"]);
    await expect(f.run()).resolves.toBe(f.child);
    expect(f.snapshots.at(-1)).toMatchObject({
      ready: true,
      body: "decoded",
      lastHttpStatus: null,
    });
    expect(f.requests).toHaveLength(1);
  });
  it.each([
    ["client-status", "client-error"],
    ["redirect-status", "redirect"],
    ["other-status", "other"],
    ["invalid-status", null],
  ])("retains only a finite status category for %s", async (outcome, category) => {
    const f = driverReadinessReplay([outcome!]);
    await expect(f.run()).rejects.toBe(f.originalFailure);
    expect(f.snapshots.at(-1)).toMatchObject({ lastHttpStatus: category });
    expect(f.requests).toHaveLength(1);
  });
  it.each([
    ["private-error", "other"],
    ["proxy-error", "other"],
    ["abort-error", "DOMException"],
  ])("closes %s without reading error values", async (outcome, errorClass) => {
    const f = driverReadinessReplay([outcome!]);
    await expect(f.run()).rejects.toBe(f.originalFailure);
    expect(f.snapshots.at(-1)).toMatchObject({ failure: "fetch", errorClass });
    expect(f.privateErrorReads()).toBe(0);
    expect(JSON.stringify(f.snapshots)).not.toMatch(/private|AbortError/);
    expect(f.requests).toHaveLength(1);
  });
  it("saturates only diagnostic counts without changing poll/request budget", async () => {
    const f = driverReadinessReplay(Array.from({ length: 1025 }, () => "not-ready"));
    await expect(f.run()).rejects.toBe(f.originalFailure);
    expect(f.requests).toHaveLength(1025);
    expect(f.snapshots.at(-1)).toMatchObject({ attempts: 1024, attemptsCapped: true });
  });
  it("admits only exact finite own data without reading private accessors", () => {
    const valid = {
      attempts: 1,
      attemptsCapped: false,
      lastHttpStatus: "success",
      ready: false,
      body: "decoded",
      failure: null,
      errorClass: null,
      driverExited: false,
      driverSpawn: "none",
    };
    expect(projectOwnedDriverReadiness(valid)).toEqual(valid);
    for (const key of Object.keys(valid)) {
      const read = vi.fn(() => "private");
      const bad = { ...valid };
      Object.defineProperty(bad, key, { enumerable: true, get: read });
      expect(projectOwnedDriverReadiness(bad)).toBeNull();
      expect(read).not.toHaveBeenCalled();
    }
    expect(projectOwnedDriverReadiness({ ...valid, token: "private" })).toBeNull();
    expect(projectOwnedDriverReadiness({ ...valid, attempts: Infinity })).toBeNull();
    expect(projectOwnedDriverReadiness({ ...valid, body: "private" })).toBeNull();
    const revoked = Proxy.revocable(valid, {});
    revoked.revoke();
    expect(projectOwnedDriverReadiness(revoked.proxy)).toBeNull();
  });
  it("leaves unavailable process facts unknown without reading accessors", async () => {
    const f = driverReadinessReplay(["ready"]);
    const read = vi.fn(() => {
      throw new Error("private process metadata");
    });
    Object.defineProperty(f.child, "child", { get: read });
    Object.defineProperty(f.child, "spawnFailure", { get: read });
    await expect(f.run()).resolves.toBe(f.child);
    expect(read).not.toHaveBeenCalled();
    expect(f.snapshots.at(-1)).toMatchObject({
      ready: true,
      driverExited: null,
      driverSpawn: null,
    });
    expect(f.requests).toHaveLength(1);
  });
});

describe("existing owned browser await boundaries", () => {
  it.each(["success", "driver-failure", "session-failure"] as const)(
    "contains a throwing stage sink at %s without changing calls or errors",
    async (outcome) => {
      const source = NodeFS.readFileSync(
        new URL("./qualification-owner.ts", import.meta.url),
        "utf8",
      );
      const start = source.indexOf("export async function openOwnedBrowser(");
      const end = source.indexOf("export async function prepareOwnedNetwork(", start);
      const stages: string[] = [],
        bounds: number[] = [];
      const owner = {},
        child = {},
        browser = {
          getAlertText: vi.fn(async () => "Inert alert."),
          addCommand: vi.fn(),
        },
        readiness = vi.fn();
      const originalFailure = new Error("Inert original browser startup failure.");
      const startDriver = vi.fn(async (...args: unknown[]) => {
        expect(args).toEqual([owner, "/owned/driver", "http://127.0.0.1:4885", readiness]);
        if (outcome === "driver-failure") throw originalFailure;
        return child;
      });
      const createSession = vi.fn(async (options: unknown) => {
        expect(options).toEqual({
          ...ownedBrowserOptions("/owned/chrome", "/owned/profile", "http://127.0.0.1:4885"),
          transformRequest: expect.any(Function),
        });
        if (outcome === "session-failure") throw originalFailure;
        return browser;
      });
      const open = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes(source.slice(start, end)).replace(/^export /gm, "") +
          "\nopenOwnedBrowser",
        {
          startOwnedBrowserDriver: startDriver,
          remote: createSession,
          ownedBrowserOptions,
          bindOwnedBrowserAlertObservation,
          bounded: (promise: Promise<unknown>, ms: number) => {
            bounds.push(ms);
            return promise;
          },
        },
      ) as (...args: unknown[]) => Promise<unknown>;
      const pending = open(
        owner,
        "/owned/chrome",
        "/owned/driver",
        "http://127.0.0.1:4885",
        "/owned/profile",
        readiness,
        (stage: string) => {
          stages.push(stage);
          throw new Error("private stage sink");
        },
      );
      if (outcome === "success") await expect(pending).resolves.toEqual({ browser, driver: child });
      else await expect(pending).rejects.toBe(originalFailure);
      expect(stages).toEqual(
        outcome === "driver-failure"
          ? ["driver-readiness"]
          : ["driver-readiness", "session-create"],
      );
      expect(browser.addCommand).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
      expect(browser.getAlertText).not.toHaveBeenCalled();
      expect(startDriver).toHaveBeenCalledTimes(1);
      expect(createSession).toHaveBeenCalledTimes(outcome === "driver-failure" ? 0 : 1);
      expect(bounds).toEqual(outcome === "driver-failure" ? [] : [45_000]);
    },
  );
});

describe("shared qualification owner", () => {
  it.each(["online", "offline", "unavailable", "setup-refused"])(
    "shared network adapter prepares once and only reads each browser: %s",
    async (outcome) => {
      const source = NodeFS.readFileSync(
        new URL("./qualification-owner.ts", import.meta.url),
        "utf8",
      );
      const start = source.indexOf("export async function prepareOwnedNetwork(");
      expect(start).toBeGreaterThan(0);
      let setups = 0,
        reads = 0;
      const bounds: number[] = [];
      const containment = {
        privateNet: true,
        pidOwnerMatches: true,
        userOwnerMatches: true,
        loopbackOnlyBefore: true,
        linksContained: true,
        routeContained: true,
        interfaceCount: 3,
        elapsedMs: 1,
      };
      const adapter = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes(
          source.slice(start).replaceAll("export async function", "async function") +
            "\n({prepareOwnedNetwork,verifyOwnedBrowserOnline})",
        ),
        {
          prepareNetworkBeforeBrowser,
          verifyPreparedBrowserOnline,
          readNetworkCommandResult,
          NetworkSetupFailure,
          NodePath,
          performance: { now: () => 100 },
          process: {
            env: {
              BIBCODE_UPLOAD_PYTHON: "/owned/python",
              BIBCODE_UPLOAD_NETWORK_HELPER: "/owned/scripts/qualify-chat-uploads.py",
            },
          },
          bounded: (promise: Promise<unknown>, ms: number) => {
            bounds.push(ms);
            return promise;
          },
          NodeChildProcess: {
            execFile: (
              _path: string,
              args: unknown,
              options: { timeout: number; maxBuffer: number },
              callback: (error: Error | null, output: string) => void,
            ) => {
              setups++;
              expect(args).toEqual(["/owned/scripts/qualify-chat-uploads.py", "network"]);
              expect(options).toMatchObject({ timeout: 30_000, maxBuffer: 4096 });
              callback(
                outcome === "setup-refused" ? new Error("private-secret") : null,
                outcome === "setup-refused" ? "private-secret" : JSON.stringify(containment),
              );
            },
          },
        },
      );
      if (outcome === "setup-refused") {
        await expect(adapter.prepareOwnedNetwork("/owned")).rejects.toBeInstanceOf(
          BrowserConnectivityFailure,
        );
        expect(setups).toBe(1);
        expect(reads).toBe(0);
        return;
      }
      const prepared = await adapter.prepareOwnedNetwork("/owned");
      expect(prepared.proof).toMatchObject({ before: null, after: null, containment });
      const browser = {
        execute: async () => {
          reads++;
          if (outcome === "unavailable") throw new Error("private-secret");
          return outcome === "online";
        },
      };
      if (outcome === "online") {
        for (let index = 0; index < 2; index++)
          expect(await adapter.verifyOwnedBrowserOnline(browser, prepared)).toMatchObject({
            before: null,
            after: true,
          });
        expect(prepared.proof.after).toBeNull();
        expect(reads).toBe(2);
        expect(bounds).toEqual([2000, 2000]);
      } else {
        try {
          await adapter.verifyOwnedBrowserOnline(browser, prepared);
          throw new Error("expected refusal");
        } catch (error) {
          expect(error).toBeInstanceOf(BrowserConnectivityFailure);
          expect((error as BrowserConnectivityFailure).proof.after).toBe(
            outcome === "offline" ? false : null,
          );
          expect(JSON.stringify(error)).not.toContain("private-secret");
        }
        expect(reads).toBe(1);
      }
      expect(setups).toBe(1);
    },
  );

  it.each([
    ["qualify-chat-uploads.ts", "  const environments = prepareEnvironments();", false],
    ["qualify-chat-uploads.ts", "  const environments = prepareEnvironments();", true],
    ["qualify-remote-updates.ts", "  terminalExecutable();", false],
    ["qualify-remote-updates.ts", "  terminalExecutable();", true],
  ] as const)(
    "prepares the real %s entrypoint before any fixture admission, refused=%s",
    async (name, marker, refused) => {
      const source = NodeFS.readFileSync(new URL("../" + name, import.meta.url), "utf8");
      const start = source.lastIndexOf("\ntry {") + 1;
      const end = source.indexOf(marker, start) + marker.length;
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const calls: string[] = [];
      const fixture = () => {
        calls.push("fixture");
        throw new Error("owned first admission");
      };
      const run = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes(
          "async function entry(){" + source.slice(start + "try {".length, end) + "}\nentry",
        ),
        {
          root: "/owned",
          phase: () => {},
          networkProof: null,
          networkProofs: [],
          prepareOwnedNetwork: async () => {
            calls.push("setup");
            if (refused) throw new Error("owned setup refused");
            return { proof: { before: null, after: null }, startedAt: 0 };
          },
          prepareEnvironments: fixture,
          terminalExecutable: fixture,
        },
      );
      await expect(run()).rejects.toThrow(
        refused ? "owned setup refused" : "owned first admission",
      );
      expect(calls).toEqual(refused ? ["setup"] : ["setup", "fixture"]);
    },
  );

  it("owns and joins its child before closing private fixture files", async () => {
    const scope = owner();
    const process = scope.spawn(
      processExec(),
      ["-e", "setTimeout(()=>{},30000)"],
      { HOME: scope.fixtureRoot },
      "primary",
    );
    try {
      expect(NodeFS.statSync(process.log).mode & 0o777).toBe(0o600);
      await scope.close();
      expect(scope.failures).toEqual([]);
      expect(scope.childrenClosed()).toBe(true);
      await process.done;
    } finally {
      await scope.close();
    }
  });

  it("continues joined child cleanup when an earlier resource cleanup fails", async () => {
    const scope = owner();
    scope.spawn(
      processExec(),
      ["-e", "setTimeout(()=>{},30000)"],
      { HOME: scope.fixtureRoot },
      "primary",
    );
    const order: string[] = [];
    await scope.close({
      browser: async () => {
        order.push("browser");
        throw new Error("private-token-secret");
      },
      proxies: [
        async () => {
          order.push("proxy");
        },
      ],
    });
    expect(order).toEqual(["browser", "proxy"]);
    expect(scope.childrenClosed()).toBe(true);
    expect(scope.failures).toHaveLength(1);
    expect(JSON.stringify(scope.failures)).not.toContain("secret");
  });

  it("supports graceful fake-host stdin exit and never overwrites a prior role log", async () => {
    const scope = owner();
    const script =
      "process.stdin.resume();process.stdin.on('data',b=>{if(b.toString().includes('exit'))process.exit(0)});";
    const first = scope.spawn(
      processExec(),
      ["-e", script],
      { HOME: scope.fixtureRoot },
      "update-a",
      true,
    );
    await scope.stop(first);
    const second = scope.spawn(
      processExec(),
      ["-e", "process.exit(0)"],
      { HOME: scope.fixtureRoot },
      "update-a",
    );
    await second.done;
    await scope.close();
    expect(first.child.exitCode).toBe(0);
    expect(first.log).not.toBe(second.log);
    expect(scope.childrenClosed()).toBe(true);
  });

  it("refuses an arbitrary role before creating a log or launching anything", () => {
    const scope = owner();
    expect(() => scope.spawn(processExec(), [], {}, "../private-role")).toThrow(
      "Unknown fixture role",
    );
    expect(scope.processes).toEqual([]);
    expect(NodeFS.readdirSync(scope.fixtureRoot)).toEqual([]);
  });

  it("does not treat an intentionally retired fixture as a later unexpected exit", async () => {
    const scope = owner();
    const child = scope.spawn(
      processExec(),
      ["-e", "setTimeout(()=>{},30000)"],
      { HOME: scope.fixtureRoot },
      "update-a",
    );
    await scope.stop(child);
    let polls = 0;
    await scope.until(async () => ++polls === 2);
    expect(polls).toBe(2);
    expect(scope.childrenClosed()).toBe(true);
  });

  it("keeps classic explicit driver ownership and preserves UTF8 request bodies", () => {
    const options = ownedBrowserOptions("/owned/chrome", "/owned/profile", "http://localhost:4901");
    expect(options).toMatchObject({
      hostname: "127.0.0.1",
      port: 4915,
      path: "/",
      connectionRetryCount: 0,
      connectionRetryTimeout: 30000,
      waitforTimeout: 30000,
      capabilities: { webSocketUrl: false, "wdio:enforceWebDriverClassic": true },
    });
    const body = '{"text":"é漢字"}';
    const result = options.transformRequest!({
      body,
      method: "POST",
      headers: { "Content-Length": "123", "X-Owned": "yes" },
    } as never);
    expect(result).toMatchObject({ body, method: "POST" });
    expect(new Headers(result.headers).has("Content-Length")).toBe(false);
    expect(new Headers(result.headers).get("X-Owned")).toBe("yes");
    expect(options.capabilities).not.toHaveProperty("goog:loggingPrefs");
    expect(options.capabilities["goog:chromeOptions"]).not.toHaveProperty("perfLoggingPrefs");
  });

  it("joins and retires a private JSON command without publishing credential output", async () => {
    const scope = owner();
    try {
      const result = await scope.json(
        processExec(),
        ["-e", 'console.log(JSON.stringify({credential:"private-secret"}))'],
        {},
      );
      expect(result).toEqual({ credential: "private-secret" });
      await scope.until(async () => true);
      expect(scope.childrenClosed()).toBe(true);
      expect(scope.failures).toEqual([]);
      expect(NodeFS.statSync(scope.processes[0]!.log).mode & 0o777).toBe(0o600);
    } finally {
      await scope.close();
    }
  });

  it("redacts malformed private JSON and still joins the command", async () => {
    const scope = owner();
    try {
      await expect(
        scope.json(processExec(), ["-e", 'console.log("private-secret-not-json")'], {}),
      ).rejects.toThrow("Owned credential response is invalid.");
      expect(scope.childrenClosed()).toBe(true);
      expect(scope.failures).toEqual([]);
    } finally {
      await scope.close();
    }
  });
});

function processExec() {
  return process.execPath;
}
