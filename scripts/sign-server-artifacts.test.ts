// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  finalizeServerArtifacts,
  parseFinalizeServerArtifactsCliArgs,
  resolveServerDetachedSigningConfiguration,
} from "./sign-server-artifacts.ts";

const sourceSha = "1".repeat(40);
const unsignedNativeSigning = {
  binary: "none",
  package: "none",
  verified: false,
  timestamped: false,
  signerSubject: null,
  signerThumbprint: null,
  teamId: null,
} as const;

async function releaseFixture(
  nativeSigning = unsignedNativeSigning,
  buildMode: "unsigned-test" | "signing-candidate" = "unsigned-test",
) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bibcode-sign-input-"));
  const output = `${root}-output`;
  const artifactName = "bibcode-server-0.4.2-x86_64-unknown-linux-gnu.tar.gz";
  const bytes = Buffer.from("artifact");
  await NodeFSP.writeFile(NodePath.join(root, artifactName), bytes);
  await NodeFSP.writeFile(
    NodePath.join(root, `${artifactName}.build.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      product: "bibcode-server",
      buildMode,
      version: "0.4.2",
      sourceSha,
      targetTriple: "x86_64-unknown-linux-gnu",
      sourceDateEpoch: 1_787_600_000,
      rustc: "rustc 1.97.1",
      binarySha256: "a".repeat(64),
      artifact: {
        downloadName: artifactName,
        os: "linux",
        architecture: "x86_64",
        format: "tar.gz",
        nativeSigning,
        notarized: false,
      },
      fileInventory: [{ path: "bin/bibcode", size: 8, sha256: "b".repeat(64) }],
    })}\n`,
  );
  return { root, output, artifactName, bytes };
}

describe("server artifact finalization", () => {
  it("parses the explicit release finalization CLI without an ambient timestamp", () => {
    expect(
      parseFinalizeServerArtifactsCliArgs([
        "--artifact-root",
        "release/candidates",
        "--output-dir",
        "release/server",
        "--channel",
        "stable",
        "--generated-at",
        "2036-08-25T12:00:00.000Z",
      ]),
    ).toEqual({
      artifactRoot: "release/candidates",
      outputDir: "release/server",
      channel: "stable",
      generatedAt: "2036-08-25T12:00:00.000Z",
    });
    expect(() =>
      parseFinalizeServerArtifactsCliArgs([
        "--artifact-root",
        "release/candidates",
        "--output-dir",
        "release/server",
        "--channel",
        "stable",
      ]),
    ).toThrow(/generated-at/iu);
  });

  it("generates SBOMs before final checksums and writes an internally bound unsigned set", async () => {
    const fixture = await releaseFixture();
    const observed: string[] = [];
    const result = await finalizeServerArtifacts(
      {
        artifactRoot: fixture.root,
        outputDir: fixture.output,
        channel: "unsigned-test",
        generatedAt: "2036-08-25T12:00:00.000Z",
      },
      {
        generateSbom: async ({ artifact, outputPath }) => {
          observed.push(`sbom:${artifact.downloadName}`);
          await NodeFSP.writeFile(
            outputPath,
            JSON.stringify({
              bomFormat: "CycloneDX",
              specVersion: "1.7",
              metadata: {
                component: {
                  name: artifact.downloadName,
                  hashes: [{ alg: "SHA-256", content: artifact.sha256 }],
                  properties: [{ name: "bibcode:sourceSha", value: sourceSha }],
                },
              },
            }),
          );
        },
        signFile: async () => {
          throw new Error("unsigned-test finalization must not invoke a signer");
        },
      },
    );

    expect(observed).toEqual([`sbom:${fixture.artifactName}`]);
    expect(result.manifest.channel).toBe("unsigned-test");
    expect(result.manifest.artifacts[0]).toMatchObject({
      downloadName: fixture.artifactName,
      sha256: NodeCrypto.createHash("sha256").update(fixture.bytes).digest("hex"),
      sbomSignatureName: `${fixture.artifactName}.cdx.json.minisig`,
    });
    expect(NodeFS.readFileSync(NodePath.join(fixture.output, "SHA256SUMS"), "utf8")).toMatch(
      new RegExp(`${fixture.artifactName.replaceAll(".", "\\.")}$`, "mu"),
    );
    expect(NodeFS.existsSync(NodePath.join(fixture.output, "artifacts.json.minisig"))).toBe(false);
  });

  it("signs artifact, SBOM, checksums, then manifest without a checksum cycle", async () => {
    const fixture = await releaseFixture(unsignedNativeSigning, "signing-candidate");
    const signed: string[] = [];
    await finalizeServerArtifacts(
      {
        artifactRoot: fixture.root,
        outputDir: fixture.output,
        channel: "beta",
        generatedAt: "2036-08-25T12:00:00.000Z",
      },
      {
        generateSbom: async ({ artifact, outputPath }) => {
          await NodeFSP.writeFile(
            outputPath,
            JSON.stringify({
              bomFormat: "CycloneDX",
              specVersion: "1.7",
              metadata: {
                component: {
                  name: artifact.downloadName,
                  hashes: [{ alg: "SHA-256", content: artifact.sha256 }],
                  properties: [{ name: "bibcode:sourceSha", value: sourceSha }],
                },
              },
            }),
          );
        },
        signFile: async ({ path, signaturePath }) => {
          signed.push(NodePath.basename(path));
          await NodeFSP.writeFile(signaturePath, `signature:${NodePath.basename(path)}`);
        },
      },
    );

    expect(signed).toEqual([
      fixture.artifactName,
      `${fixture.artifactName}.cdx.json`,
      "SHA256SUMS",
      "artifacts.json",
    ]);
    const checksums = NodeFS.readFileSync(NodePath.join(fixture.output, "SHA256SUMS"), "utf8");
    expect(checksums).toContain(fixture.artifactName);
    expect(checksums).toContain(`${fixture.artifactName}.cdx.json`);
    expect(checksums).not.toContain("SHA256SUMS");
    expect(checksums).not.toContain("artifacts.json");
  });

  it("fails stable Windows finalization without verified timestamped Authenticode", async () => {
    const fixture = await releaseFixture(unsignedNativeSigning, "signing-candidate");
    const metadataPath = NodePath.join(fixture.root, `${fixture.artifactName}.build.json`);
    const metadata = JSON.parse(NodeFS.readFileSync(metadataPath, "utf8")) as Record<
      string,
      unknown
    >;
    metadata.targetTriple = "x86_64-pc-windows-msvc";
    metadata.artifact = {
      downloadName: fixture.artifactName,
      os: "windows",
      architecture: "x86_64",
      format: "zip",
      nativeSigning: unsignedNativeSigning,
      notarized: false,
    };
    await NodeFSP.writeFile(metadataPath, JSON.stringify(metadata));

    await expect(
      finalizeServerArtifacts(
        {
          artifactRoot: fixture.root,
          outputDir: fixture.output,
          channel: "stable",
          generatedAt: "2036-08-25T12:00:00.000Z",
        },
        {
          generateSbom: async () => undefined,
          signFile: async () => undefined,
        },
      ),
    ).rejects.toThrow(/Authenticode/iu);
  });

  it("requires both dedicated detached-signing secrets and never returns them in diagnostics", () => {
    const privateCanary = "PRIVATE_CANARY_DO_NOT_PRINT";
    const passwordCanary = "PASSWORD_CANARY_DO_NOT_PRINT";
    expect(() =>
      resolveServerDetachedSigningConfiguration("stable", {
        BIBCODE_SERVER_SIGNING_PRIVATE_KEY: privateCanary,
      }),
    ).toThrowError(
      expect.objectContaining({
        message: expect.not.stringContaining(privateCanary),
      }),
    );
    const resolved = resolveServerDetachedSigningConfiguration("stable", {
      BIBCODE_SERVER_SIGNING_PRIVATE_KEY: privateCanary,
      BIBCODE_SERVER_SIGNING_PRIVATE_KEY_PASSWORD: passwordCanary,
    });
    expect(resolved).toEqual({ privateKey: privateCanary, password: passwordCanary });
    expect(JSON.stringify(resolved)).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
  });
});
