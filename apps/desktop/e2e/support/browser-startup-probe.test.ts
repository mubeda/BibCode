// @effect-diagnostics nodeBuiltinImport:off - Inert QA tests inspect their own immutable controller source.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import { describe, expect, it } from "vite-plus/test";
import {
  parseQualificationMode,
  projectStartupNetworkLogs,
  runCredentialFreeStartupProbe,
} from "./browser-startup-probe.ts";

describe("credential-free startup probe", () => {
  it("admits remaining qualification only through its explicit separate profile", () => {
    expect(parseQualificationMode("remaining-qualification")).toBe("remaining-qualification");
    expect(parseQualificationMode(undefined)).toBe("upload-smoke");
  });
  it.each([
    "null",
    "[]",
    "{}",
    '{"message":null}',
    '{"message":[]}',
    '{"message":{}}',
    '{"message":{"method":7}}',
    '{"message":{"method":""}}',
    '{"message":{"method":"   "}}',
  ])("marks invalid performance envelope %s partial before ignoring methods", (message) => {
    expect(projectStartupNetworkLogs([{ message }])).toMatchObject({
      available: true,
      truncated: true,
      entries: 1,
      malformed: 1,
      failures: 0,
    });
  });

  it("ignores valid unrelated events without treating unknown failure categories as malformed", () => {
    const input = [
      {
        message: JSON.stringify({
          message: { method: "Network.loadingFinished", params: { requestId: "private" } },
        }),
      },
      {
        message: JSON.stringify({
          message: {
            method: "Network.loadingFailed",
            params: { type: "private-unknown", errorText: "private-unknown" },
          },
        }),
      },
    ];
    const result = projectStartupNetworkLogs(input);
    expect(result).toMatchObject({
      available: true,
      truncated: false,
      malformed: 0,
      failures: 1,
      types: { unknown: 1 },
      errors: { unknown: 1 },
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("uses a separate explicit startup-only workflow and no raw log artifacts", () => {
    const yaml = NodeModule.createRequire(
      new URL("../../../../scripts/package.json", import.meta.url),
    )("yaml");
    const workflow = yaml.parse(
      NodeFS.readFileSync(
        new URL("../../../../.github/workflows/qualify-chat-startup.yml", import.meta.url),
        "utf8",
      ),
    );
    expect(workflow.on.push.branches).toEqual(["codex/qualify-chat-startup"]);
    expect(workflow.jobs.startup_only.env.BIBCODE_UPLOAD_MODE).toBe("startup-only");
    const artifact = workflow.jobs.startup_only.steps.find((step: { uses?: string }) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(artifact.with.name).toContain("startup-only");
    expect(artifact.with.path).not.toMatch(/\.log|\*|plain-smoke|failure-after-pair/);
    const normal = yaml.parse(
      NodeFS.readFileSync(
        new URL("../../../../.github/workflows/qualify-chat-uploads.yml", import.meta.url),
        "utf8",
      ),
    );
    expect(normal.jobs.browser_uploads.env.BIBCODE_UPLOAD_MODE).toBeUndefined();
  });
  it("enables performance collection only in the actual startup-only browser capabilities", () => {
    const source = NodeFS.readFileSync(
      new URL("../qualify-chat-uploads.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("      capabilities: {");
    const end = source.indexOf("\n      },\n    }),", start);
    expect(end).toBeGreaterThan(start);
    const object = "({" + source.slice(start, end + "\n      },".length) + "})";
    for (const qualificationMode of ["upload-smoke", "startup-only"]) {
      const value = NodeVM.runInNewContext(object, {
        qualificationMode,
        chrome: "/owned/chrome",
        fixtureRoot: "/owned/profile",
        NodePath,
      });
      if (qualificationMode === "startup-only") {
        expect(value.capabilities["goog:loggingPrefs"]).toEqual({ performance: "ALL" });
        expect(value.capabilities["goog:chromeOptions"].perfLoggingPrefs).toEqual({
          enableNetwork: true,
          enablePage: false,
        });
      } else {
        expect(value.capabilities).not.toHaveProperty("goog:loggingPrefs");
        expect(value.capabilities["goog:chromeOptions"]).not.toHaveProperty("perfLoggingPrefs");
      }
    }
  });
  it("keeps upload mode default and rejects unknown selectors", () => {
    expect(parseQualificationMode(undefined)).toBe("upload-smoke");
    expect(parseQualificationMode("startup-only")).toBe("startup-only");
    expect(() => parseQualificationMode("private-unknown")).toThrow("qualification mode");
  });

  it("retains only closed loading failure types and codes", () => {
    const input = [
      {
        message: JSON.stringify({
          message: {
            method: "Network.loadingFailed",
            params: {
              type: "Script",
              errorText: "net::ERR_NETWORK_CHANGED",
              requestId: "private-id",
              url: "http://private.invalid/credential",
              headers: { authorization: "secret" },
            },
          },
        }),
      },
      {
        message: JSON.stringify({
          message: {
            method: "Network.loadingFailed",
            params: { type: "private", errorText: "credential-secret", canceled: true },
          },
        }),
      },
    ];
    const observed = projectStartupNetworkLogs(input);
    expect(observed).toMatchObject({
      available: true,
      failures: 2,
      types: { script: 1, unknown: 1 },
      errors: { "network-changed": 1, unknown: 1 },
      canceled: 1,
    });
    expect(JSON.stringify(observed)).not.toMatch(/private|secret|credential|https?:\/\//);
    expect(projectStartupNetworkLogs(null)).toMatchObject({ available: false, failures: null });
  });

  it("bounds malformed/oversized log work and marks missing evidence honestly", () => {
    const oversized = { message: "x".repeat(20_000) };
    const observed = projectStartupNetworkLogs(
      Array.from({ length: 5000 }, () => ({ ...oversized })),
    );
    expect(observed).toMatchObject({
      available: true,
      truncated: true,
      entries: 4096,
      malformed: 4096,
      failures: 0,
    });
  });

  it.each([false, true])(
    "collects terminal logs after readiness failure=%s without auth ports",
    async (fails) => {
      const calls: string[] = [];
      const outcome = await runCredentialFreeStartupProbe({
        readPerformanceLogs: async () => {
          calls.push("logs");
          return [];
        },
        navigate: async () => {
          calls.push("navigate");
        },
        waitForPairingControl: async () => {
          calls.push("wait");
          if (fails) throw new Error("private");
        },
      });
      expect(calls).toEqual(["logs", "navigate", "wait", "logs"]);
      expect(outcome.reachedPairingControl).toBe(!fails);
      expect(JSON.stringify(outcome)).not.toContain("private");
    },
  );

  it("never substitutes missing performance capture with an upload attempt", async () => {
    let navigations = 0;
    const result = await runCredentialFreeStartupProbe({
      readPerformanceLogs: async () => {
        throw new Error("private");
      },
      navigate: async () => {
        navigations++;
      },
      waitForPairingControl: async () => {},
    });
    expect(result).toMatchObject({
      reachedPairingControl: false,
      network: { available: false, failures: null },
    });
    expect(navigations).toBe(0);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it.each(["ready", "not-ready", "unavailable", "throwing"])(
    "actual controller cannot mint or enter credentials for probe outcome=%s",
    async (outcome) => {
      const source = NodeFS.readFileSync(
        new URL("../qualify-chat-uploads.ts", import.meta.url),
        "utf8",
      );
      const start = source.indexOf('  if (qualificationMode === "startup-only") {');
      const end = source.indexOf("\n} catch (error)", start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      let mint = 0,
        uploaded = 0;
      const run = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes(
          "async function scenario() {" + source.slice(start, end) + "}\nscenario",
        ),
        {
          qualificationMode: "startup-only",
          phase: () => {},
          runCredentialFreeStartupProbe: async () => {
            if (outcome === "throwing") throw new Error("owned probe failure");
            return {
              reachedPairingControl: outcome !== "not-ready",
              network: { available: outcome !== "unavailable" },
            };
          },
          projectBrowserStartupObservation: (value: unknown) => value,
          b: {
            execute: async () => ({ installed: true }),
            getLogs: async () => [],
            url: async () => {},
            $: () => ({ waitForDisplayed: async () => {} }),
          },
          webOrigin: "http://localhost:4901",
          bounded: (value: Promise<unknown>) => value,
          NodeChildProcess: {
            execFileSync: () => {
              mint++;
              throw new Error("credential branch");
            },
          },
          NodeFS: {
            writeFileSync: () => {
              uploaded++;
              throw new Error("upload branch");
            },
          },
          results: [],
          startupNetworkObservation: null,
          startupObservation: null,
          success: false,
        },
      );
      if (outcome === "throwing") await expect(run()).rejects.toThrow("owned probe failure");
      else if (outcome !== "ready")
        await expect(run()).rejects.toThrow("credential-free startup probe");
      else await run();
      expect({ mint, uploaded }).toEqual({ mint: 0, uploaded: 0 });
    },
  );

  it.each([false, true])("actual startup-only result cannot claim an upload pass=%s", (success) => {
    const source = NodeFS.readFileSync(
      new URL("../qualify-chat-uploads.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf('  write("result", {');
    const end = source.indexOf("\n}\nprocess.exitCode", start);
    let receipt: Record<string, unknown> = {};
    NodeVM.runInNewContext(source.slice(start, end), {
      success,
      oldInput: null,
      selectedMatrixCase: null,
      qualificationMode: "startup-only",
      currentPhase: "pair-wait-token",
      process: { env: {} },
      results: [],
      networkProof: null,
      onlineAfterPairFailure: null,
      pairingObservation: null,
      startupObservation: null,
      startupNetworkObservation: null,
      beforeCleanup: [],
      cleanupFailures: [],
      processes: [],
      write: (_name: string, value: Record<string, unknown>) => {
        receipt = value;
      },
    });
    expect(receipt).toMatchObject({
      success: false,
      qualificationMode: "startup-only",
      startupProbePassed: success,
      results: [],
    });
    expect(receipt.scope).toContain("startup-only");
  });
});

it("accepts only the new explicit matrix mode alongside unchanged smoke/startup defaults", () => {
  expect(parseQualificationMode("upload-matrix")).toBe("upload-matrix");
  expect(parseQualificationMode(undefined)).toBe("upload-smoke");
  expect(parseQualificationMode("startup-only")).toBe("startup-only");
});
