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
  NodeFS.writeFileSync(NodePath.join(root, "server.tar.gz.minisig"), "signature");
  NodeFS.writeFileSync(NodePath.join(root, "server.cdx.json"), "{}");
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
          sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
          signatureName: "server.tar.gz.minisig",
          sbomName: "server.cdx.json",
          nativeSigning: { binary: "none", package: "none", verified: false },
          notarized: false,
        },
      ],
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

  it.each(["size", "sha256", "signatureName", "sbomName"] as const)(
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
      else artifact[field] = field === "signatureName" ? "missing.minisig" : "missing.cdx.json";
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
    await expect(runVerifyServerArtifactsMain(["--directory", root])).rejects.toThrow("Usage");
  });
});
