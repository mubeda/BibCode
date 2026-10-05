// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import { HostProcessPlatform } from "@bibcode/shared/hostProcess";
import * as Effect from "effect/Effect";
import { it as effectIt } from "@effect/vitest";
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

  it("uses independent no-build lookup jobs and leaves payload diagnosis manual-only", async () => {
    const lookup = await NodeFSP.readFile(
      new URL("../.github/workflows/macos-workspace-diagnostic.yml", import.meta.url),
      "utf8",
    );
    const payload = await NodeFSP.readFile(
      new URL("../.github/workflows/macos-icon-diagnostic.yml", import.meta.url),
      "utf8",
    );
    expect(payload).not.toContain("  push:");
    expect(payload).toContain("  workflow_dispatch:");
    expect(lookup).toContain("label: Intel control");
    expect(lookup).toContain("label: Intel application initialization");
    expect(lookup).toContain("label: ARM control");
    expect(lookup).toContain("label: Intel 15 control");
    expect(lookup).toContain("runner: macos-15-intel");
    expect(lookup).toContain("fail-fast: false");
    expect(lookup).toContain('MAC_ICON_DIAGNOSTIC_LOOKUP_ONLY: "1"');
    expect(lookup).toContain("MAC_ICON_DIAGNOSTIC_SINGLE_ARM: ${{ matrix.arm }}");
    expect(lookup).toContain("diagnostic-evidence/document.txt");
    expect(lookup).not.toContain("build-desktop-artifact");
    expect(lookup).not.toContain("Setup Rust");
    expect(lookup).not.toContain("hdiutil");
  });

  effectIt.effect("refuses a reused or symlinked witness namespace before any native call", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      if (platform === "win32") return;
      yield* Effect.promise(async () => {
        const config = await setup();
        const workflow = await NodeFSP.readFile(
          new URL("../.github/workflows/macos-workspace-diagnostic.yml", import.meta.url),
          "utf8",
        );
        const prelude = workflow
          .split("run: |\n")[1]!
          .split("node scripts/diagnose-macos-icon.ts")[0]!
          .replace(/^          /gm, "");
        const run = () =>
          NodeChildProcess.spawnSync("bash", ["-c", prelude], {
            cwd: config.cwd,
            encoding: "utf8",
          });
        expect(run().status).toBe(0);
        const document = NodePath.join(config.cwd, "diagnostic-evidence", "document.txt");
        await NodeFSP.writeFile(document, "preserved witness");
        expect(run().status).not.toBe(0);
        expect(await NodeFSP.readFile(document, "utf8")).toBe("preserved witness");
        await NodeFSP.rm(NodePath.dirname(document), { recursive: true });
        const other = NodePath.join(config.cwd, "unrelated");
        await NodeFSP.mkdir(other);
        await NodeFSP.writeFile(NodePath.join(other, "document.txt"), "preserved other witness");
        await NodeFSP.symlink(other, NodePath.dirname(document));
        expect(run().status).not.toBe(0);
        expect(await NodeFSP.readFile(NodePath.join(other, "document.txt"), "utf8")).toBe(
          "preserved other witness",
        );
      });
    }),
  );

  it.each(["CONTROL", "SHARED_INIT"] as const)(
    "stops a fresh %s job after lookup return without asserting pixel acceptance",
    async (singleArm) => {
      const config = await setup();
      const results = await runMacIconExperiment({
        ...config,
        singleArm,
        lookupOnly: true,
        execute: async (input) => {
          const fixtures = input.args[1] === "--self-test";
          expect(input.env!.MAC_ICON_DIAGNOSTIC_INITIALIZE_APPLICATION).toBe(
            singleArm === "SHARED_INIT" ? "1" : "0",
          );
          expect(input.env!.MAC_ICON_DIAGNOSTIC_LOOKUP_ONLY).toBe(fixtures ? "0" : "1");
          await NodeFSP.writeFile(
            input.env!.MAC_ICON_DIAGNOSTIC_RECORDS_PATH!,
            fixtures
              ? '{"stage":"swift-entry"}\n'
              : '{"stage":"workspace-shared-returned"}\n{"stage":"icon-lookup-returned"}\n',
          );
          return successful(fixtures);
        },
      });
      expect(results).toHaveLength(2);
      expect(results[1]).toMatchObject({
        arm: singleArm,
        phase: "LOOKUP",
        outcome: "LOOKUP_RETURNED",
        closeVerified: true,
      });
      expect(results.every((row) => row.phase !== "PAYLOAD")).toBe(true);
    },
  );

  it("stops a fresh lookup job after its first timeout instead of reusing system-service state", async () => {
    const config = await setup();
    const results = await runMacIconExperiment({
      ...config,
      singleArm: "CONTROL",
      lookupOnly: true,
      execute: async (input) => {
        const fixtures = input.args[1] === "--self-test";
        await NodeFSP.writeFile(
          input.env!.MAC_ICON_DIAGNOSTIC_RECORDS_PATH!,
          '{"stage":"workspace-shared-dispatched"}\n',
        );
        if (!fixtures)
          throw new SeededUpgradeCommandTimeoutError("synthetic joined lookup deadline");
        return successful(true);
      },
    });
    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({
      phase: "LOOKUP",
      outcome: "TIMED_OUT",
      closeVerified: true,
    });
  });

  it("requires both split returns and single-arm isolation for a lookup-only report", async () => {
    const config = await setup();
    await expect(
      runMacIconExperiment({ ...config, lookupOnly: true, execute: async () => successful(true) }),
    ).rejects.toThrow("SINGLE_ARM_REQUIRED");
    const results = await runMacIconExperiment({
      ...config,
      singleArm: "CONTROL",
      lookupOnly: true,
      execute: async (input) => {
        const fixtures = input.args[1] === "--self-test";
        await NodeFSP.writeFile(
          input.env!.MAC_ICON_DIAGNOSTIC_RECORDS_PATH!,
          '{"stage":"workspace-returned"}\n',
        );
        return successful(fixtures);
      },
    });
    expect(results[1]).toMatchObject({ phase: "LOOKUP", outcome: "EXIT_WITHOUT_VERDICT" });
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

  it("retains bounded per-stage elapsed time without machine timestamps", () => {
    expect(
      decodeMacIconObservations(
        '{"stage":"icon-lookup-returned","elapsedMs":111057,"elapsedCapped":false,"machineTimestamp":"private"}',
      ),
    ).toEqual([{ stage: "icon-lookup-returned", elapsedMs: 111057, elapsedCapped: false }]);
    expect(() =>
      decodeMacIconObservations('{"stage":"icon-lookup-returned","elapsedMs":-1}'),
    ).toThrow("VALUE");
    expect(() =>
      decodeMacIconObservations('{"stage":"icon-lookup-returned","elapsedMs":3600001}'),
    ).toThrow("VALUE");
    expect(() =>
      decodeMacIconObservations('{"stage":"icon-lookup-returned","elapsedCapped":"false"}'),
    ).toThrow("VALUE");
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
