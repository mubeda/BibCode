// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  decodeMacIconObservations,
  requireMacIconDiagnosticCI,
  runMacIconExperiment,
} from "./diagnose-macos-icon.ts";
import { SeededUpgradeCommandTimeoutError } from "./seeded-desktop-upgrade-smoke.ts";

const roots: Array<string> = [];
async function setup() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bibcode-icon-diagnostic-"));
  roots.push(root);
  return {
    evidenceRoot: root,
    cwd: root,
    appPath: "/synthetic/BiBCode.app",
    scriptPath: "/synthetic/check.swift",
  };
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const successful = (fixtures: boolean) => ({
  exitCode: 0,
  stdout: fixtures ? "PASS: Finder icon raster fixtures\n" : "PASS\n",
  stderr: "",
});
async function writeObservations(
  input: { readonly env?: NodeJS.ProcessEnv | undefined },
  accepted: boolean,
) {
  await NodeFSP.writeFile(
    input.env!.MAC_ICON_DIAGNOSTIC_RECORDS_PATH!,
    JSON.stringify({
      stage: accepted ? "verdict-accepted" : "draw-dispatched",
    }) + "\n",
  );
}

describe("macOS icon diagnostic protocol", () => {
  it("keeps product provenance, signing, safe cleanup and closed-only retention in the separate workflow", async () => {
    const workflow = await NodeFSP.readFile(
      new URL("../.github/workflows/macos-icon-diagnostic.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain("ref: f0632e2550ee4ca16363c18b8a4b1ed7c548f32e");
    expect(workflow).toContain("ref: ${{ github.sha }}");
    expect(workflow).toContain("path: diagnostic-tooling");
    expect(workflow).toContain("runs-on: macos-26-intel");
    expect(workflow).toContain("timeout-minutes: 90");
    expect(workflow).toContain("hdiutil attach -readonly -nobrowse -noautoopen");
    expect(workflow).toContain("codesign --verify --deep --strict");
    expect(workflow).toContain("if [[ -f diagnostic-evidence/cleanup-safe ]]");
    expect(
      workflow.indexOf("cp diagnostic-tooling/scripts/diagnose-macos-icon.ts"),
    ).toBeGreaterThan(workflow.indexOf("node scripts/build-desktop-artifact.ts"));
    const retained = workflow.split("path: |\n").at(-1)!;
    expect(retained).toContain("diagnostic-evidence/observations.json");
    expect(retained).toContain("diagnostic-evidence/payload.sha256");
    expect(retained).not.toContain("private.log");
    expect(workflow).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
  });

  it("admits only GitHub native macOS CI", () => {
    expect(() => requireMacIconDiagnosticCI({}, "darwin")).toThrow("CI_ONLY");
    expect(() =>
      requireMacIconDiagnosticCI({ CI: "true", GITHUB_ACTIONS: "true" }, "linux"),
    ).toThrow("CI_ONLY");
    expect(() =>
      requireMacIconDiagnosticCI({ CI: "true", GITHUB_ACTIONS: "true" }, "darwin"),
    ).not.toThrow();
  });

  it("refuses real native execution through the exported runner outside CI", async () => {
    vi.stubEnv("GITHUB_ACTIONS", "false");
    const config = await setup();
    await expect(runMacIconExperiment(config)).rejects.toThrow("CI_ONLY");
    expect(await NodeFSP.readdir(config.evidenceRoot)).toEqual([]);
  });

  it("projects only closed stages and bounded values without private fields", () => {
    expect(
      decodeMacIconObservations(
        JSON.stringify({ stage: "draw-dispatched", path: "/private", error: "private error" }),
      ),
    ).toEqual([{ stage: "draw-dispatched" }]);
    expect(() => decodeMacIconObservations('{"stage":"unknown"}')).toThrow("STAGE");
    expect(() =>
      decodeMacIconObservations('{"stage":"pixel-scan-returned","opaque":1048577}'),
    ).toThrow("VALUE");
    expect(() => decodeMacIconObservations('{"stage":"pixel-scan-returned","dark":-1}')).toThrow(
      "VALUE",
    );
    expect(() =>
      decodeMacIconObservations('{"stage":"pixel-scan-dispatched","width":16385}'),
    ).toThrow("VALUE");
    expect(() =>
      decodeMacIconObservations('{"stage":"pixel-scan-returned","countsCapped":"false"}'),
    ).toThrow("VALUE");
    expect(() => decodeMacIconObservations(" ".repeat(65_537))).toThrow("BOUND");
    expect(() => decodeMacIconObservations('{"stage":"swift-entry"}\n'.repeat(65))).toThrow(
      "COUNT",
    );
  });

  it("waits for the prior owner before admitting treatment and repeats control to detect warming", async () => {
    const config = await setup();
    const calls: Array<{ readonly arm: string; readonly phase: string }> = [];
    let releaseControl: (() => void) | undefined;
    const joined = new Promise<void>((resolve) => {
      releaseControl = resolve;
    });
    const pending = runMacIconExperiment({
      ...config,
      execute: async (input) => {
        const fixtures = input.args[1] === "--self-test";
        const arm = NodePath.basename(input.env!.MAC_ICON_DIAGNOSTIC_RECORDS_PATH!).split("-")[0]!;
        calls.push({ arm, phase: fixtures ? "FIXTURES" : "PAYLOAD" });
        expect(input.timeoutMs).toBe(120_000);
        expect(input.command).toBe("swift");
        if (!fixtures && arm === "CONTROL") {
          await writeObservations(input, false);
          await joined;
          throw new SeededUpgradeCommandTimeoutError("synthetic joined deadline");
        }
        expect(input.env!.MAC_ICON_DIAGNOSTIC_INITIALIZE_APPLICATION).toBe(
          arm === "SHARED_INIT" ? "1" : "0",
        );
        await writeObservations(input, !fixtures);
        return successful(fixtures);
      },
    });
    await expect.poll(() => calls.length).toBe(2);
    expect(calls).toEqual([
      { arm: "CONTROL", phase: "FIXTURES" },
      { arm: "CONTROL", phase: "PAYLOAD" },
    ]);
    await expect(
      NodeFSP.stat(NodePath.join(config.evidenceRoot, "cleanup-safe")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    releaseControl!();
    const results = await pending;
    expect(results.map((row) => [row.arm, row.phase, row.outcome])).toEqual([
      ["CONTROL", "FIXTURES", "ACCEPTED"],
      ["CONTROL", "PAYLOAD", "TIMED_OUT"],
      ["SHARED_INIT", "FIXTURES", "ACCEPTED"],
      ["SHARED_INIT", "PAYLOAD", "ACCEPTED"],
      ["CONTROL_REPEAT", "FIXTURES", "ACCEPTED"],
      ["CONTROL_REPEAT", "PAYLOAD", "ACCEPTED"],
    ]);
    expect(results.every((row) => row.closeVerified)).toBe(true);
    const report = JSON.parse(
      await NodeFSP.readFile(NodePath.join(config.evidenceRoot, "observations.json"), "utf8"),
    );
    expect(report).toMatchObject({ diagnosticOnly: true, releaseQualified: false });
  });

  it("tests equivalent-grid rectangle scaling only when both actual processes time out", async () => {
    const config = await setup();
    const results = await runMacIconExperiment({
      ...config,
      execute: async (input) => {
        const fixtures = input.args[1] === "--self-test";
        const rectangle = input.env!.MAC_ICON_DIAGNOSTIC_RECT_ONLY === "1";
        await writeObservations(input, rectangle && !fixtures);
        if (!fixtures && !rectangle)
          throw new SeededUpgradeCommandTimeoutError("synthetic joined deadline");
        return successful(fixtures);
      },
    });
    expect(results.map((row) => row.arm)).toEqual([
      "CONTROL",
      "CONTROL",
      "SHARED_INIT",
      "SHARED_INIT",
      "RECT_ONLY",
      "RECT_ONLY",
    ]);
    expect(results.at(-1)).toMatchObject({
      phase: "PAYLOAD",
      outcome: "ACCEPTED",
      closeVerified: true,
    });
  });

  it.each([
    {
      controlFixtureTimeout: true,
      treatmentFixtureTimeout: true,
      controlPayloadTimeout: false,
      expectedCount: 2,
    },
    {
      controlFixtureTimeout: true,
      treatmentFixtureTimeout: false,
      controlPayloadTimeout: false,
      expectedCount: 3,
    },
    {
      controlFixtureTimeout: false,
      treatmentFixtureTimeout: true,
      controlPayloadTimeout: true,
      expectedCount: 3,
    },
  ])(
    "does not admit optional comparisons after a fixture timeout: $expectedCount rows",
    async (scenario) => {
      const config = await setup();
      const results = await runMacIconExperiment({
        ...config,
        execute: async (input) => {
          const fixtures = input.args[1] === "--self-test";
          const arm = NodePath.basename(input.env!.MAC_ICON_DIAGNOSTIC_RECORDS_PATH!).split(
            "-",
          )[0]!;
          await writeObservations(input, !fixtures);
          if (
            (fixtures && arm === "CONTROL" && scenario.controlFixtureTimeout) ||
            (fixtures && arm === "SHARED_INIT" && scenario.treatmentFixtureTimeout) ||
            (!fixtures && arm === "CONTROL" && scenario.controlPayloadTimeout)
          ) {
            throw new SeededUpgradeCommandTimeoutError("synthetic joined fixture deadline");
          }
          return successful(fixtures);
        },
      });
      expect(results).toHaveLength(scenario.expectedCount);
      expect(results.every((row) => row.arm === "CONTROL" || row.arm === "SHARED_INIT")).toBe(true);
    },
  );

  it("fails closed on cleanup or spawn failure before treatment or safe unmount", async () => {
    const config = await setup();
    let calls = 0;
    await expect(
      runMacIconExperiment({
        ...config,
        execute: async (input) => {
          calls += 1;
          await writeObservations(input, false);
          if (calls === 2) throw new Error("synthetic owner cleanup failed");
          return successful(true);
        },
      }),
    ).rejects.toThrow("OWNER_FAILED");
    expect(calls).toBe(2);
    await expect(
      NodeFSP.stat(NodePath.join(config.evidenceRoot, "cleanup-safe")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not mistake an exit without observed payload verdict for acceptance", async () => {
    const config = await setup();
    const results = await runMacIconExperiment({
      ...config,
      execute: async (input) => {
        const fixtures = input.args[1] === "--self-test";
        await writeObservations(input, false);
        return successful(fixtures);
      },
    });
    expect(
      results
        .filter((row) => row.phase === "PAYLOAD")
        .every((row) => row.outcome === "EXIT_WITHOUT_VERDICT"),
    ).toBe(true);
    expect(results).toHaveLength(4);
  });
});
