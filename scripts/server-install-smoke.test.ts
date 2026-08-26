// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off - The fixture injects one deterministic evidence timestamp.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  SERVER_INSTALL_SMOKE_SCENARIOS,
  parseServerInstallSmokeCliArgs,
  runServerInstallSmoke,
  type ServerInstallSmokeDriver,
} from "./server-install-smoke.ts";
import { createNativeServerInstallSmokeDriver } from "./lib/server-install-smoke-driver.ts";

const sourceSha = "1".repeat(40);

async function fixture() {
  const artifactRoot = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "bibcode-install-smoke-artifacts-"),
  );
  const workRoot = `${artifactRoot}-work`;
  const artifactName = "bibcode-server-0.4.2-aarch64-apple-darwin.tar.gz";
  const artifactBytes = Buffer.from("packaged server");
  const artifactSha256 = NodeCrypto.createHash("sha256").update(artifactBytes).digest("hex");
  const sbomName = `${artifactName}.cdx.json`;
  const sbom = JSON.stringify({
    bomFormat: "CycloneDX",
    specVersion: "1.7",
    metadata: {
      component: {
        name: artifactName,
        hashes: [{ alg: "SHA-256", content: artifactSha256 }],
        properties: [{ name: "bibcode:sourceSha", value: sourceSha }],
      },
    },
  });
  const sbomSha256 = NodeCrypto.createHash("sha256").update(sbom).digest("hex");
  const checksums = `${artifactSha256}  ${artifactName}\n${sbomSha256}  ${sbomName}\n`;
  const manifestPath = NodePath.join(artifactRoot, "artifacts.json");
  await Promise.all([
    NodeFSP.writeFile(NodePath.join(artifactRoot, artifactName), artifactBytes),
    NodeFSP.writeFile(NodePath.join(artifactRoot, sbomName), sbom),
    NodeFSP.writeFile(NodePath.join(artifactRoot, "SHA256SUMS"), checksums),
  ]);
  await NodeFSP.writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      product: "bibcode-server",
      version: "0.4.2",
      channel: "unsigned-test",
      sourceSha,
      generatedAt: "2036-08-25T12:00:00.000Z",
      requiredMatrix: [
        {
          targetTriple: "aarch64-apple-darwin",
          os: "macos",
          architecture: "aarch64",
          format: "tar.gz",
        },
      ],
      artifacts: [
        {
          product: "bibcode-server",
          version: "0.4.2",
          sourceSha,
          targetTriple: "aarch64-apple-darwin",
          os: "macos",
          architecture: "aarch64",
          format: "tar.gz",
          downloadName: artifactName,
          size: artifactBytes.length,
          sha256: artifactSha256,
          signatureName: `${artifactName}.minisig`,
          sbomName,
          sbomSha256,
          sbomSignatureName: `${sbomName}.minisig`,
          nativeSigning: {
            binary: "adhoc",
            package: "none",
            verified: false,
            timestamped: false,
            signerSubject: null,
            signerThumbprint: null,
            teamId: null,
          },
          notarized: false,
        },
      ],
      checksumsName: "SHA256SUMS",
      checksumsSha256: NodeCrypto.createHash("sha256").update(checksums).digest("hex"),
      checksumsSignatureName: "SHA256SUMS.minisig",
      manifestSignatureName: "artifacts.json.minisig",
    }),
  );
  return { artifactName, artifactRoot, manifestPath, workRoot };
}

const completeDriver = (canary = ""): ServerInstallSmokeDriver => ({
  async execute(context) {
    expect(context.artifactPath).toContain(context.artifact.downloadName);
    return SERVER_INSTALL_SMOKE_SCENARIOS.map((scenario) => ({
      scenario,
      status: "passed" as const,
      classification: "native" as const,
      code: `verified${canary}`,
    }));
  },
  async cleanup() {},
});

describe("server install smoke harness", () => {
  it("parses the bounded manifest-driven CLI", () => {
    expect(
      parseServerInstallSmokeCliArgs([
        "--manifest",
        "/tmp/release/artifacts.json",
        "--artifact-root",
        "/tmp/release",
        "--os",
        "macos",
        "--architecture",
        "aarch64",
        "--format",
        "tar.gz",
        "--work-root",
        "/tmp/server-smoke",
        "--stage-timeout-ms",
        "120000",
        "--command-timeout-ms",
        "30000",
        "--allow-unsigned-test",
        "--allow-system-mutation",
      ]),
    ).toEqual({
      manifestPath: "/tmp/release/artifacts.json",
      artifactRoot: "/tmp/release",
      os: "macos",
      architecture: "aarch64",
      format: "tar.gz",
      workRoot: "/tmp/server-smoke",
      stageTimeoutMs: 120_000,
      commandTimeoutMs: 30_000,
      allowUnsignedTest: true,
      allowSystemMutation: true,
    });
    expect(() => parseServerInstallSmokeCliArgs(["--manifest", "relative.json"])).toThrow(/Usage/);
  });

  it("verifies bytes before creating a fresh work root and records every approved scenario", async () => {
    const input = await fixture();
    const evidence = await runServerInstallSmoke(
      {
        ...input,
        os: "macos",
        architecture: "aarch64",
        format: "tar.gz",
        allowUnsignedTest: true,
        stageTimeoutMs: 5_000,
        commandTimeoutMs: 1_000,
      },
      { driver: completeDriver(), now: () => new Date("2036-08-25T13:00:00.000Z") },
    );

    expect(evidence.sourceSha).toBe(sourceSha);
    expect(evidence.artifact.downloadName).toBe(input.artifactName);
    expect(evidence.scenarios.map(({ scenario }) => scenario)).toEqual(
      SERVER_INSTALL_SMOKE_SCENARIOS,
    );
    expect(evidence.scenarios.every(({ status }) => status === "passed")).toBe(true);
    expect(
      JSON.parse(NodeFS.readFileSync(NodePath.join(input.workRoot, "evidence.json"), "utf8")),
    ).toEqual(evidence);
  });

  it("rejects aliases, nested/nonempty roots, tuple ambiguity, and unsigned input by default", async () => {
    const equivalent = await fixture();
    await expect(
      runServerInstallSmoke(
        {
          ...equivalent,
          workRoot: equivalent.artifactRoot,
          os: "macos",
          architecture: "aarch64",
          format: "tar.gz",
        },
        { driver: completeDriver() },
      ),
    ).rejects.toThrow(/distinct/iu);

    const nested = await fixture();
    await expect(
      runServerInstallSmoke(
        {
          ...nested,
          workRoot: NodePath.join(nested.artifactRoot, "work"),
          os: "macos",
          architecture: "aarch64",
          format: "tar.gz",
        },
        { driver: completeDriver() },
      ),
    ).rejects.toThrow(/distinct/iu);

    const nonempty = await fixture();
    await NodeFSP.mkdir(nonempty.workRoot);
    await NodeFSP.writeFile(NodePath.join(nonempty.workRoot, "owned.txt"), "user data");
    await expect(
      runServerInstallSmoke(
        {
          ...nonempty,
          os: "macos",
          architecture: "aarch64",
          format: "tar.gz",
          allowUnsignedTest: true,
        },
        { driver: completeDriver() },
      ),
    ).rejects.toThrow(/empty/iu);
    expect(NodeFS.readFileSync(NodePath.join(nonempty.workRoot, "owned.txt"), "utf8")).toBe(
      "user data",
    );

    const unsigned = await fixture();
    await expect(
      runServerInstallSmoke(
        {
          ...unsigned,
          os: "macos",
          architecture: "aarch64",
          format: "tar.gz",
        },
        { driver: completeDriver() },
      ),
    ).rejects.toThrow(/explicit verifier opt-in/iu);
    expect(NodeFS.existsSync(unsigned.workRoot)).toBe(false);
  });

  it("always invokes cleanup and rejects missing/duplicate scenario evidence", async () => {
    const input = await fixture();
    let cleaned = 0;
    const driver: ServerInstallSmokeDriver = {
      async execute() {
        return [
          {
            scenario: "clean-workstation-install",
            status: "passed",
            classification: "native",
            code: "installed",
          },
        ];
      },
      async cleanup() {
        cleaned += 1;
      },
    };
    await expect(
      runServerInstallSmoke(
        {
          ...input,
          os: "macos",
          architecture: "aarch64",
          format: "tar.gz",
          allowUnsignedTest: true,
        },
        { driver },
      ),
    ).rejects.toThrow(/exactly one result/iu);
    expect(cleaned).toBe(1);
  });

  it("aborts a timed-out stage before cleanup receives a fresh cancellation scope", async () => {
    const input = await fixture();
    const observed: string[] = [];
    const driver: ServerInstallSmokeDriver = {
      execute(context) {
        return new Promise((_resolve, reject) => {
          context.abortSignal.addEventListener(
            "abort",
            () => {
              observed.push("execution-aborted");
              reject(new Error("cancelled by test"));
            },
            { once: true },
          );
        });
      },
      async cleanup(context) {
        expect(context.abortSignal.aborted).toBe(false);
        observed.push("cleanup-started");
      },
    };

    await expect(
      runServerInstallSmoke(
        {
          ...input,
          os: "macos",
          architecture: "aarch64",
          format: "tar.gz",
          allowUnsignedTest: true,
          stageTimeoutMs: 1_000,
          commandTimeoutMs: 1_000,
        },
        { driver },
      ),
    ).rejects.toThrow(/cleanup was attempted/iu);
    expect(observed).toEqual(["execution-aborted", "cleanup-started"]);
  });

  it("never writes seeded secret, path, or user canaries to evidence or public errors", async () => {
    const input = await fixture();
    const canary = " SECRET_TOKEN_/Users/private/alice@example.test";
    await expect(
      runServerInstallSmoke(
        {
          ...input,
          os: "macos",
          architecture: "aarch64",
          format: "tar.gz",
          allowUnsignedTest: true,
        },
        { driver: completeDriver(canary) },
      ),
    ).rejects.toThrow(/safe evidence code/iu);
    const evidencePath = NodePath.join(input.workRoot, "evidence.json");
    if (NodeFS.existsSync(evidencePath)) {
      expect(NodeFS.readFileSync(evidencePath, "utf8")).not.toContain(canary);
    }
  });

  it("executes the portable native lifecycle through bounded argument-array commands", async () => {
    const input = await fixture();
    const observed: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
    const dataRoot = NodePath.join(input.workRoot, "data");
    const driver = createNativeServerInstallSmokeDriver({
      repoRoot: NodePath.resolve(import.meta.dirname, ".."),
      async fetchJson(url) {
        expect(url).toBe("http://127.0.0.1:3773/.well-known/bibcode/environment");
        return {
          environmentId: "11111111-1111-4111-8111-111111111111",
          storageInstanceId: "22222222-2222-4222-8222-222222222222",
          transport: { mode: "loopback-http" },
        };
      },
      async runCommand(request) {
        observed.push({ command: request.command, args: request.args });
        if (request.command === "tar") {
          const destination = request.args[request.args.indexOf("-C") + 1];
          if (!destination) throw new Error("missing fake extraction destination");
          const binary = NodePath.join(destination, "bin", "bibcode");
          await NodeFSP.mkdir(NodePath.dirname(binary), { recursive: true });
          await NodeFSP.writeFile(binary, "packaged binary", { mode: 0o700 });
          return { exitCode: 0, stdout: "" };
        }
        if (request.args[0] === "service" && request.args[1] === "install") {
          const requestedRoot = request.args.at(-1);
          if (!requestedRoot) throw new Error("missing fake service root");
          await NodeFSP.mkdir(requestedRoot, { recursive: true });
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              operation: "install",
              changed: false,
              status: {
                state: "running",
                dataRoot: requestedRoot,
                bind: "127.0.0.1:3773",
                definitionMatches: true,
              },
            }),
          };
        }
        if (request.args[0] === "service" && request.args[1] === "status") {
          const requestedRoot = request.args.at(-1);
          if (!requestedRoot) throw new Error("missing fake status root");
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              operation: "status",
              status: {
                state: "running",
                dataRoot: requestedRoot,
                bind: "127.0.0.1:3773",
                definitionMatches: true,
              },
            }),
          };
        }
        if (request.args[0] === "storage" && request.args[1] === "inspect") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              storageInstanceId: "22222222-2222-4222-8222-222222222222",
              backups: [{ backupId: "44444444-4444-4444-8444-444444444444" }],
              backupIssues: [],
            }),
          };
        }
        if (request.args[0] === "storage" && request.args[2] === "plan") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ planId: "33333333-3333-4333-8333-333333333333" }),
          };
        }
        if (request.args[0] === "storage" && request.args[2] === "execute") {
          const rootIndex = request.args.indexOf("--base-dir");
          const requestedRoot = request.args[rootIndex + 1];
          if (!requestedRoot) throw new Error("missing fake purge root");
          await NodeFSP.rm(requestedRoot, { recursive: true });
          return { exitCode: 0, stdout: JSON.stringify({ removed: true }) };
        }
        return { exitCode: 0, stdout: "{}" };
      },
    });

    const evidence = await runServerInstallSmoke(
      {
        ...input,
        os: "macos",
        architecture: "aarch64",
        format: "tar.gz",
        allowUnsignedTest: true,
      },
      { driver, now: () => new Date("2036-08-25T13:00:00.000Z") },
    );

    expect(evidence.scenarios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scenario: "clean-workstation-install", status: "passed" }),
        expect.objectContaining({
          scenario: "upgrade-preserves-data-and-backup",
          status: "passed",
        }),
        expect.objectContaining({
          scenario: "failed-upgrade-recovers-safely",
          classification: "native",
        }),
        expect.objectContaining({
          scenario: "headless-account-and-acl",
          status: "unavailable",
          code: "requires-native-package",
        }),
      ]),
    );
    expect(observed.some(({ command }) => command === "tar")).toBe(true);
    expect(
      observed.some(
        ({ args }) => args[0] === "storage" && args[1] === "purge" && args[2] === "execute",
      ),
    ).toBe(true);
    expect(observed.every(({ command }) => !/[;&|`]/u.test(command))).toBe(true);
    expect(NodeFS.existsSync(dataRoot)).toBe(false);
  });
});
