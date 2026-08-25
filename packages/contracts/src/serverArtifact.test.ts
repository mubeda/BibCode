import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ServerArtifactManifestSchema, ServerArtifactSelectionSchema } from "./serverArtifact.ts";

const decodeManifest = Schema.decodeUnknownSync(ServerArtifactManifestSchema);
const decodeSelection = Schema.decodeUnknownSync(ServerArtifactSelectionSchema);

const linuxArtifact = {
  product: "bibcode-server",
  version: "0.4.2",
  os: "linux",
  architecture: "x86_64",
  format: "tar.gz",
  downloadName: "bibcode-server-linux-x86_64.tar.gz",
  size: 4096,
  sha256: "a".repeat(64),
  signatureName: "bibcode-server-linux-x86_64.tar.gz.sig",
} as const;

describe("ServerArtifactManifestSchema", () => {
  it("selects by manifest metadata rather than a guessed filename", () => {
    const manifest = decodeManifest({
      schemaVersion: 1,
      product: "bibcode-server",
      version: "0.4.2",
      generatedAt: "2036-08-25T12:00:00.000Z",
      artifacts: [
        linuxArtifact,
        {
          ...linuxArtifact,
          os: "macos",
          architecture: "universal",
          format: "pkg",
          downloadName: "server-for-macos.pkg",
          signatureName: "server-for-macos.pkg.sig",
          sha256: "b".repeat(64),
        },
      ],
    });
    const artifact = manifest.artifacts.find(
      (candidate) =>
        candidate.os === "linux" &&
        candidate.architecture === "x86_64" &&
        candidate.format === "tar.gz",
    );

    expect(
      decodeSelection({
        target: {
          product: "bibcode-server",
          version: "0.4.2",
          os: "linux",
          architecture: "x86_64",
        },
        artifact,
      }).artifact.downloadName,
    ).toBe("bibcode-server-linux-x86_64.tar.gz");
  });

  it.each([
    [{ ...linuxArtifact, sha256: "not-a-hash" }, "checksum"],
    [{ ...linuxArtifact, downloadName: "../server.tar.gz" }, "download path"],
    [{ ...linuxArtifact, signatureName: "/tmp/server.sig" }, "signature path"],
    [{ ...linuxArtifact, size: 0 }, "empty artifact"],
    [
      { ...linuxArtifact, os: "windows", architecture: "universal", format: "msi" },
      "invalid universal target",
    ],
  ] as const)("rejects a manifest %s mismatch (%s)", (artifact, _label) => {
    expect(() =>
      decodeManifest({
        schemaVersion: 1,
        product: "bibcode-server",
        version: "0.4.2",
        generatedAt: "2036-08-25T12:00:00.000Z",
        artifacts: [artifact],
      }),
    ).toThrow();
  });

  it("rejects record version drift and duplicate target records", () => {
    expect(() =>
      decodeManifest({
        schemaVersion: 1,
        product: "bibcode-server",
        version: "0.4.2",
        generatedAt: "2036-08-25T12:00:00.000Z",
        artifacts: [{ ...linuxArtifact, version: "0.4.1" }],
      }),
    ).toThrow();
    expect(() =>
      decodeManifest({
        schemaVersion: 1,
        product: "bibcode-server",
        version: "0.4.2",
        generatedAt: "2036-08-25T12:00:00.000Z",
        artifacts: [linuxArtifact, { ...linuxArtifact, downloadName: "duplicate.tar.gz" }],
      }),
    ).toThrow();
  });

  it("rejects a selected record that does not match the requested target", () => {
    expect(() =>
      decodeSelection({
        target: {
          product: "bibcode-server",
          version: "0.4.2",
          os: "macos",
          architecture: "aarch64",
        },
        artifact: linuxArtifact,
      }),
    ).toThrow();
  });
});
