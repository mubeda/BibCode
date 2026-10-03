// @effect-diagnostics nodeBuiltinImport:off - Inert qualification tests inspect their actual controller source.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";
import {
  BrowserConnectivityFailure,
  prepareNetworkBeforeBrowser,
  verifyPreparedBrowserOnline,
  parseNetworkProof,
  parseNetworkFailure,
  NetworkSetupFailure,
  readNetworkCommandResult,
  type NetworkContainmentProof,
} from "./browser-network.ts";

const containment = {
  privateNet: true,
  pidOwnerMatches: true,
  userOwnerMatches: true,
  loopbackOnlyBefore: true,
  linksContained: true,
  routeContained: true,
  interfaceCount: 3,
  elapsedMs: 1,
} as const;

it.each(["online", "offline", "setup-refused"])(
  "actual controller orders contained preparation and refuses safely: %s",
  async (outcome) => {
    const source = NodeFS.readFileSync(
      new URL("../qualify-chat-uploads.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("try {\n", source.indexOf("let beforeCleanup:"));
    const end = source.indexOf("  const plain = environments[0]!;", start);
    expect(start).toBeGreaterThan(0);
    const calls: string[] = [];
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "async function controller() {" +
          source.slice(start + "try {".length, end) +
          "}\ncontroller",
      ),
      {
        prepareEnvironments: () => {
          calls.push("fixture");
          return [
            {
              kind: "plain",
              serverPort: 4902,
              proxyPort: 4903,
              context: { stateRoot: "/owned/state" },
              env: {},
            },
          ];
        },
        phase: () => {},
        spawn: (_command: string, _args: unknown, _env: unknown, role: string) => {
          calls.push(role);
        },
        until: async () => {},
        bounded: (promise: Promise<unknown>) => promise,
        startThrottleProxy: async () => ({}),
        proxies: [],
        process: {
          execPath: "/owned/node",
          env: {
            BIBCODE_UPLOAD_PYTHON: "/owned/python",
            BIBCODE_UPLOAD_NETWORK_HELPER: "/owned/scripts/qualify-chat-uploads.py",
          },
        },
        NodePath,
        root: "/owned",
        serverBinary: "/owned/server",
        webOrigin: "http://localhost:4901",
        webEnv: {},
        driver: "/owned/driver",
        chrome: "/owned/chrome",
        fixtureRoot: "/owned/fixture",
        qualificationMode: "startup-only",
        observationScript: "",
        networkProof: null,
        remote: async () => {
          calls.push("browser");
          return {
            sendCommandAndGetResult: async () => {},
            execute: async () => {
              calls.push("online");
              return outcome !== "offline";
            },
          };
        },
        performance: { now: () => 0 },
        delay: async () => {},
        prepareNetworkBeforeBrowser,
        verifyPreparedBrowserOnline,
        NodeChildProcess: {
          execFile: (
            _program: string,
            _args: unknown,
            _options: unknown,
            callback: (error: Error | null, stdout: string) => void,
          ) => {
            calls.push("setup");
            callback(
              outcome === "setup-refused" ? new Error("private") : null,
              outcome === "setup-refused" ? "invalid-private-proof" : JSON.stringify(containment),
            );
          },
        },
        readNetworkCommandResult,
        NetworkSetupFailure,
      },
    );
    if (outcome === "online") await run();
    else await expect(run()).rejects.toBeInstanceOf(BrowserConnectivityFailure);
    expect(calls[0]).toBe("setup");
    if (outcome === "setup-refused") {
      expect(calls).toEqual(["setup"]);
    } else {
      expect(calls.indexOf("setup")).toBeLessThan(calls.indexOf("plain"));
      expect(calls.indexOf("setup")).toBeLessThan(calls.indexOf("browser"));
      expect(calls.filter((value) => value === "online")).toHaveLength(1);
    }
    expect(calls.filter((value) => value === "setup")).toHaveLength(1);
  },
);
function fixture(values: unknown[]) {
  let time = 0;
  return {
    readOnline: vi.fn(async () => (values.length > 1 ? values.shift() : values[0])),
    setup: vi.fn(async (): Promise<NetworkContainmentProof> => containment),
    now: () => time,
    sleep: vi.fn(async (ms: number) => {
      time += ms;
    }),
  };
}
it("prepares once before a browser exists and reports its online state unobserved", async () => {
  const f = fixture([true]);
  const prepared = await prepareNetworkBeforeBrowser(f);
  expect(prepared).toMatchObject({ before: null, after: null, setupRan: true, containment });
  expect(f.setup).toHaveBeenCalledOnce();
  expect(f.readOnline).not.toHaveBeenCalled();
  expect(f.sleep).not.toHaveBeenCalled();
  const proof = await verifyPreparedBrowserOnline(prepared, {
    readOnline: f.readOnline,
    now: f.now,
    startedAt: 0,
  });
  expect(proof).toMatchObject({ before: null, after: true, setupRan: true, containment });
  expect(JSON.parse(JSON.stringify(proof)).before).toBeNull();
  expect(f.readOnline).toHaveBeenCalledOnce();
  expect(f.setup).toHaveBeenCalledOnce();
});
it.each([false, undefined, null, "false", 0, {}])(
  "post-creation online observation %s never repairs or retries",
  async (value) => {
    const f = fixture([value]);
    const prepared = await prepareNetworkBeforeBrowser(f);
    let failure: unknown;
    try {
      await verifyPreparedBrowserOnline(prepared, {
        readOnline: f.readOnline,
        now: f.now,
        startedAt: 0,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(BrowserConnectivityFailure);
    expect((failure as BrowserConnectivityFailure).proof).toMatchObject({
      before: null,
      after: value === false ? false : null,
      setupRan: true,
      setupFailure: null,
    });
    expect(f.setup).toHaveBeenCalledOnce();
    expect(f.readOnline).toHaveBeenCalledOnce();
    expect(f.sleep).not.toHaveBeenCalled();
  },
);
it("failed preparation never observes or starts a browser and retains only closed failure", async () => {
  const f = fixture([true]);
  f.setup.mockRejectedValueOnce(new Error("credential-secret raw routes"));
  try {
    await prepareNetworkBeforeBrowser(f);
  } catch (error) {
    expect(JSON.stringify(error)).not.toContain("credential-secret");
    expect((error as BrowserConnectivityFailure).proof).toMatchObject({
      before: null,
      after: null,
      setupRan: true,
      containment: null,
    });
  }
  expect(f.readOnline).not.toHaveBeenCalled();
});
it("proof decoder refuses extra fields, false containment and unbounded numeric values", () => {
  expect(parseNetworkProof(JSON.stringify(containment))).toEqual(containment);
  for (const value of [
    { ...containment, routeContained: false },
    { ...containment, ip: "secret" },
    { ...containment, elapsedMs: Infinity },
    { ...containment, interfaceCount: 4 },
  ])
    expect(() => parseNetworkProof(JSON.stringify(value))).toThrow();
});

const refusal = {
  stage: "mutation-pair",
  attemptedMutations: 1,
  completedMutations: 0,
  netAdminEffective: false,
  lastCommand: { exitCode: 2, timedOut: false, cancelled: false, reaped: true },
} as const;
it("retains strict helper refusal stage/counts/status through the existing browser failure", async () => {
  const f = fixture([false]);
  f.setup.mockRejectedValueOnce(
    new NetworkSetupFailure(
      parseNetworkFailure(JSON.stringify({ refused: true, failure: refusal })),
    ),
  );
  try {
    await prepareNetworkBeforeBrowser(f);
  } catch (error) {
    expect((error as BrowserConnectivityFailure).proof.setupFailure).toEqual(refusal);
    expect((error as BrowserConnectivityFailure).proof.containment).toBeNull();
  }
});
it("refusal decoder rejects foreign fields and invalid stages/counts/status without disclosure", () => {
  for (const failure of [
    { ...refusal, stage: "secret" },
    { ...refusal, attemptedMutations: 7 },
    { ...refusal, completedMutations: 2 },
    { ...refusal, path: "secret" },
    { ...refusal, lastCommand: { ...refusal.lastCommand, exitCode: 999 } },
    { ...refusal, lastCommand: { ...refusal.lastCommand, stderr: "secret" } },
  ]) {
    expect(() => parseNetworkFailure(JSON.stringify({ refused: true, failure }))).toThrow();
  }
});
it("does not retain foreign fields added to a typed helper exception", async () => {
  const f = fixture([false]);
  const failure = new NetworkSetupFailure(refusal);
  Object.assign(failure.failure, { path: "secret" });
  f.setup.mockRejectedValueOnce(failure);
  try {
    await prepareNetworkBeforeBrowser(f);
  } catch (error) {
    expect(JSON.stringify(error)).not.toContain("secret");
    expect((error as BrowserConnectivityFailure).proof.setupFailure).toEqual(refusal);
  }
});

it("projects nonzero helper stdout into the browser receipt and malformed output into unknown counts", async () => {
  for (const [output, expected] of [
    [JSON.stringify({ refused: true, failure: refusal }), refusal],
    [
      JSON.stringify({ refused: true, failure: { ...refusal, raw: "secret" } }),
      {
        stage: "helper-process",
        attemptedMutations: null,
        completedMutations: null,
        netAdminEffective: null,
        lastCommand: null,
      },
    ],
  ] as const) {
    const f = fixture([false]);
    f.setup.mockImplementationOnce(async () => readNetworkCommandResult(true, output));
    try {
      await prepareNetworkBeforeBrowser(f);
    } catch (error) {
      expect((error as BrowserConnectivityFailure).proof.setupFailure).toEqual(expected);
      expect(JSON.stringify(error)).not.toContain("secret");
    }
  }
});

it("refusal JSON syntax errors expose only the closed decoder message", () => {
  expect(() => parseNetworkFailure("foreign-secret")).toThrow("Contained refusal proof refused.");
});

it.each([
  "after-ifindex-check",
  "after-peer-relation-check",
  "after-peer-format-check",
  "after-peer-namespace-check",
  "after-indices-check",
] as const)("accepts only the closed peer predicate stage %s", (stage) => {
  const proof = { ...refusal, stage, attemptedMutations: 6, completedMutations: 6 };
  expect(parseNetworkFailure(JSON.stringify({ refused: true, failure: proof }))).toEqual(proof);
  expect(() =>
    parseNetworkFailure(
      JSON.stringify({ refused: true, failure: { ...proof, stage: "after-peer-secret" } }),
    ),
  ).toThrow();
});
