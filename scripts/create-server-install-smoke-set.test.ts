// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  createServerInstallSmokeSet,
  parseCreateServerInstallSmokeSetCliArgs,
} from "./create-server-install-smoke-set.ts";
import { verifyServerArtifacts } from "./verify-server-artifacts.ts";

describe("native install-smoke release set", () => {
  it("parses only an explicit artifact root, output root, and source epoch", () => {
    expect(
      parseCreateServerInstallSmokeSetCliArgs([
        "--artifact-root",
        "/tmp/candidate",
        "--output-dir",
        "/tmp/smoke-set",
        "--source-date-epoch",
        "1756080000",
      ]),
    ).toEqual({
      artifactRoot: "/tmp/candidate",
      outputDir: "/tmp/smoke-set",
      sourceDateEpoch: 1_756_080_000,
    });
    expect(() =>
      parseCreateServerInstallSmokeSetCliArgs([
        "--artifact-root",
        "/tmp/candidate",
        "--output-dir",
        "/tmp/smoke-set",
        "--source-date-epoch",
        "0",
      ]),
    ).toThrow(/positive integer/iu);
  });

  it("creates a byte-bound unsigned manifest without release SBOM tooling", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bibcode-smoke-set-"));
    const artifactRoot = NodePath.join(root, "candidate");
    const outputDir = NodePath.join(root, "verified");
    await NodeFSP.mkdir(artifactRoot);
    const artifactName = "bibcode-server-0.4.2-linux-x86_64.tar.gz";
    const artifact = Buffer.from("native install smoke artifact");
    const artifactSha256 = NodeCrypto.createHash("sha256").update(artifact).digest("hex");
    const sourceSha = "2".repeat(40);
    await Promise.all([
      NodeFSP.writeFile(NodePath.join(artifactRoot, artifactName), artifact),
      NodeFSP.writeFile(
        NodePath.join(artifactRoot, `${artifactName}.build.json`),
        `${JSON.stringify({
          schemaVersion: 1,
          product: "bibcode-server",
          buildMode: "signing-candidate",
          version: "0.4.2",
          sourceSha,
          targetTriple: "x86_64-unknown-linux-gnu",
          sourceDateEpoch: 1_756_080_000,
          rustc: "rustc fixture",
          binarySha256: artifactSha256,
          artifact: {
            downloadName: artifactName,
            os: "linux",
            architecture: "x86_64",
            format: "tar.gz",
            nativeSigning: {
              binary: "none",
              package: "none",
              verified: false,
              timestamped: false,
              signerSubject: null,
              signerThumbprint: null,
              teamId: null,
            },
            notarized: false,
          },
          fileInventory: [{ path: "bin/bibcode", size: artifact.length, sha256: artifactSha256 }],
        })}\n`,
      ),
    ]);

    const result = await createServerInstallSmokeSet({
      artifactRoot,
      outputDir,
      sourceDateEpoch: 1_756_080_000,
    });
    expect(result.manifest.channel).toBe("unsigned-test");
    const verified = await verifyServerArtifacts({
      manifestPath: NodePath.join(outputDir, "artifacts.json"),
      directory: outputDir,
      allowUnsignedTest: true,
    });
    expect(verified.artifacts).toHaveLength(1);
    const sbom = JSON.parse(
      await NodeFSP.readFile(NodePath.join(outputDir, `${artifactName}.cdx.json`), "utf8"),
    ) as { readonly metadata: { readonly component: { readonly properties: unknown } } };
    expect(sbom.metadata.component.properties).toContainEqual({
      name: "bibcode:validationScope",
      value: "native-install-smoke",
    });
  });
});
