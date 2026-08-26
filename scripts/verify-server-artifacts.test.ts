// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { runVerifyServerArtifactsMain, verifyServerArtifacts } from "./verify-server-artifacts.ts";

function fixture(): { readonly root: string; readonly manifest: string } {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-server-manifest-"));
  const bytes = Buffer.from("server archive");
  NodeFS.writeFileSync(NodePath.join(root, "server.tar.gz"), bytes);
  const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  const sbom = JSON.stringify({
    bomFormat: "CycloneDX",
    specVersion: "1.7",
    metadata: {
      component: {
        name: "server.tar.gz",
        hashes: [{ alg: "SHA-256", content: sha256 }],
        properties: [{ name: "bibcode:sourceSha", value: "1".repeat(40) }],
      },
    },
  });
  NodeFS.writeFileSync(NodePath.join(root, "server.cdx.json"), sbom);
  const sbomSha256 = NodeCrypto.createHash("sha256").update(sbom).digest("hex");
  const checksums = [
    { name: "server.tar.gz", sha256 },
    { name: "server.cdx.json", sha256: sbomSha256 },
  ]
    .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))
    .map((entry) => `${entry.sha256}  ${entry.name}\n`)
    .join("");
  NodeFS.writeFileSync(NodePath.join(root, "SHA256SUMS"), checksums);
  const manifest = NodePath.join(root, "artifacts.json");
  NodeFS.writeFileSync(
    manifest,
    JSON.stringify({
      schemaVersion: 1,
      product: "bibcode-server",
      version: "0.4.2",
      channel: "unsigned-test",
      sourceSha: "1".repeat(40),
      generatedAt: "2036-08-25T12:00:00.000Z",
      requiredMatrix: [
        {
          targetTriple: "x86_64-unknown-linux-gnu",
          os: "linux",
          architecture: "x86_64",
          format: "tar.gz",
        },
      ],
      artifacts: [
        {
          product: "bibcode-server",
          version: "0.4.2",
          sourceSha: "1".repeat(40),
          targetTriple: "x86_64-unknown-linux-gnu",
          os: "linux",
          architecture: "x86_64",
          format: "tar.gz",
          downloadName: "server.tar.gz",
          size: bytes.length,
          sha256,
          signatureName: "server.tar.gz.minisig",
          sbomName: "server.cdx.json",
          sbomSha256,
          sbomSignatureName: "server.cdx.json.minisig",
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
      ],
      checksumsName: "SHA256SUMS",
      checksumsSha256: NodeCrypto.createHash("sha256").update(checksums).digest("hex"),
      checksumsSignatureName: "SHA256SUMS.minisig",
      manifestSignatureName: "artifacts.json.minisig",
    }),
  );
  return { root, manifest };
}

describe("verifyServerArtifacts", () => {
  it("verifies the exact tuple, file links, size, and streaming SHA-256", async () => {
    const { root, manifest } = fixture();
    const verified = await verifyServerArtifacts({
      directory: root,
      manifestPath: manifest,
      allowUnsignedTest: true,
    });
    expect(verified.artifacts[0]?.downloadName).toBe("server.tar.gz");
  });

  it("rejects unsigned-test output without explicit permission", async () => {
    const { root, manifest } = fixture();
    await expect(
      verifyServerArtifacts({ directory: root, manifestPath: manifest }),
    ).rejects.toThrow("explicit verifier opt-in");
  });

  it("rejects a partial manifest when complete release coverage is required", async () => {
    const { root, manifest } = fixture();
    await expect(
      verifyServerArtifacts({
        directory: root,
        manifestPath: manifest,
        allowUnsignedTest: true,
        requireCompleteMatrix: true,
      }),
    ).rejects.toThrow(/complete server release matrix/iu);
  });

  it("rejects a manifest path that is itself a symbolic link", async () => {
    const { root, manifest } = fixture();
    const plainManifest = NodePath.join(root, "plain-artifacts.json");
    NodeFS.renameSync(manifest, plainManifest);
    try {
      NodeFS.symlinkSync(plainManifest, manifest);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "EPERM" || error.code === "EACCES")
      ) {
        return;
      }
      throw error;
    }

    await expect(
      verifyServerArtifacts({
        directory: root,
        manifestPath: manifest,
        allowUnsignedTest: true,
      }),
    ).rejects.toThrow("plain file");
  });

  it.each(["size", "sha256", "sbomSha256", "sbomName"] as const)(
    "rejects a tampered %s binding",
    async (field) => {
      const { root, manifest } = fixture();
      const value = JSON.parse(NodeFS.readFileSync(manifest, "utf8")) as {
        artifacts: Array<Record<string, unknown>>;
      };
      const artifact = value.artifacts[0];
      if (!artifact) throw new Error("fixture artifact");
      if (field === "size") artifact.size = 1;
      else if (field === "sha256") artifact.sha256 = "0".repeat(64);
      else if (field === "sbomSha256") artifact[field] = "0".repeat(64);
      else artifact[field] = "missing.cdx.json";
      NodeFS.writeFileSync(manifest, JSON.stringify(value));
      await expect(
        verifyServerArtifacts({
          directory: root,
          manifestPath: manifest,
          allowUnsignedTest: true,
        }),
      ).rejects.toThrow();
    },
  );

  it("rejects checksum-set drift and an SBOM that is not bound to artifact bytes", async () => {
    const checksumFixture = fixture();
    NodeFS.appendFileSync(
      NodePath.join(checksumFixture.root, "SHA256SUMS"),
      `${"0".repeat(64)}  extra\n`,
    );
    await expect(
      verifyServerArtifacts({
        directory: checksumFixture.root,
        manifestPath: checksumFixture.manifest,
        allowUnsignedTest: true,
      }),
    ).rejects.toThrow(/checksum/iu);

    const sbomFixture = fixture();
    const sbomPath = NodePath.join(sbomFixture.root, "server.cdx.json");
    const sbom = JSON.parse(NodeFS.readFileSync(sbomPath, "utf8")) as {
      metadata: { component: { hashes: Array<{ content: string }> } };
    };
    const firstHash = sbom.metadata.component.hashes[0];
    if (!firstHash) throw new Error("fixture SBOM hash");
    firstHash.content = "0".repeat(64);
    NodeFS.writeFileSync(sbomPath, JSON.stringify(sbom));
    const manifestValue = JSON.parse(NodeFS.readFileSync(sbomFixture.manifest, "utf8")) as {
      artifacts: Array<{ sbomSha256: string }>;
    };
    const firstArtifact = manifestValue.artifacts[0];
    if (!firstArtifact) throw new Error("fixture artifact");
    firstArtifact.sbomSha256 = NodeCrypto.createHash("sha256")
      .update(NodeFS.readFileSync(sbomPath))
      .digest("hex");
    NodeFS.writeFileSync(sbomFixture.manifest, JSON.stringify(manifestValue));
    await expect(
      verifyServerArtifacts({
        directory: sbomFixture.root,
        manifestPath: sbomFixture.manifest,
        allowUnsignedTest: true,
      }),
    ).rejects.toThrow(/SBOM.*bound/iu);
  });

  it("verifies every detached signature for signed channels", async () => {
    const { root, manifest } = fixture();
    const value = JSON.parse(NodeFS.readFileSync(manifest, "utf8")) as { channel: string };
    value.channel = "beta";
    NodeFS.writeFileSync(manifest, JSON.stringify(value));
    for (const name of [
      "server.tar.gz.minisig",
      "server.cdx.json.minisig",
      "SHA256SUMS.minisig",
      "artifacts.json.minisig",
    ]) {
      NodeFS.writeFileSync(NodePath.join(root, name), "signature");
    }
    const verified: string[] = [];
    await verifyServerArtifacts({
      directory: root,
      manifestPath: manifest,
      verifySignature: async ({ path }) => {
        verified.push(NodePath.basename(path));
      },
    });
    expect(verified).toEqual(["artifacts.json", "server.tar.gz", "server.cdx.json", "SHA256SUMS"]);
  });

  it("parses only the bounded CLI surface", async () => {
    const { root, manifest } = fixture();
    await expect(
      runVerifyServerArtifactsMain([
        "--manifest",
        manifest,
        "--directory",
        root,
        "--allow-unsigned-test",
      ]),
    ).resolves.toBeUndefined();
    await expect(
      runVerifyServerArtifactsMain([
        "--manifest",
        manifest,
        "--directory",
        root,
        "--allow-unsigned-test",
        "--require-complete-matrix",
      ]),
    ).rejects.toThrow(/complete server release matrix/iu);
    await expect(runVerifyServerArtifactsMain(["--directory", root])).rejects.toThrow("Usage");
  });
});
