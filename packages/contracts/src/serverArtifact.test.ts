import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ServerArtifactManifestSchema, ServerArtifactSelectionSchema } from "./serverArtifact.ts";

const decodeManifest = Schema.decodeUnknownSync(ServerArtifactManifestSchema);
const decodeSelection = Schema.decodeUnknownSync(ServerArtifactSelectionSchema);
const sourceSha = "1".repeat(40);

const linuxArtifact = {
  product: "bibcode-server",
  version: "0.4.2",
  sourceSha,
  targetTriple: "x86_64-unknown-linux-gnu",
  os: "linux",
  architecture: "x86_64",
  format: "tar.gz",
  downloadName: "bibcode-server-linux-x86_64.tar.gz",
  size: 4096,
  sha256: "a".repeat(64),
  signatureName: "bibcode-server-linux-x86_64.tar.gz.minisig",
  sbomName: "bibcode-server-linux-x86_64.cdx.json",
  nativeSigning: { binary: "none", package: "none", verified: false },
  notarized: false,
} as const;

const requirementFor = (artifact: typeof linuxArtifact) => ({
  targetTriple: artifact.targetTriple,
  os: artifact.os,
  architecture: artifact.architecture,
  format: artifact.format,
});

const manifestFor = (
  artifacts: ReadonlyArray<Record<string, unknown>>,
  channel = "unsigned-test",
) => ({
  schemaVersion: 1,
  product: "bibcode-server",
  version: "0.4.2",
  channel,
  sourceSha,
  generatedAt: "2036-08-25T12:00:00.000Z",
  requiredMatrix: artifacts.map((artifact) => ({
    targetTriple: artifact.targetTriple,
    os: artifact.os,
    architecture: artifact.architecture,
    format: artifact.format,
  })),
  artifacts,
  manifestSignatureName: "artifacts.json.minisig",
});

describe("ServerArtifactManifestSchema", () => {
  it("selects by the requested tuple and preferred formats rather than a guessed filename", () => {
    const manifest = decodeManifest(manifestFor([linuxArtifact]));
    const artifact = manifest.artifacts[0];

    expect(
      decodeSelection({
        target: {
          product: "bibcode-server",
          version: "0.4.2",
          os: "linux",
          architecture: "x86_64",
          preferredFormats: ["tar.gz"],
        },
        artifact,
      }).artifact.downloadName,
    ).toBe("bibcode-server-linux-x86_64.tar.gz");
  });

  it.each([
    [{ ...linuxArtifact, sha256: "not-a-hash" }, "checksum"],
    [{ ...linuxArtifact, sourceSha: "short" }, "source SHA"],
    [{ ...linuxArtifact, downloadName: "../server.tar.gz" }, "download traversal"],
    [{ ...linuxArtifact, signatureName: "server∕sig" }, "Unicode separator"],
    [{ ...linuxArtifact, size: 0 }, "empty artifact"],
    [{ ...linuxArtifact, targetTriple: "aarch64-unknown-linux-gnu" }, "target triple"],
    [{ ...linuxArtifact, format: "msi" }, "OS format"],
    [
      {
        ...linuxArtifact,
        os: "windows",
        targetTriple: "x86_64-pc-windows-msvc",
        nativeSigning: { binary: "none", package: "none", verified: true },
      },
      "unsupported signing state",
    ],
  ] as const)("rejects a record mismatch (%s: %s)", (artifact, _label) => {
    expect(() => decodeManifest(manifestFor([artifact]))).toThrow();
  });

  it("rejects duplicate, missing, and extra required tuples", () => {
    expect(() =>
      decodeManifest({
        ...manifestFor([linuxArtifact]),
        requiredMatrix: [requirementFor(linuxArtifact), requirementFor(linuxArtifact)],
      }),
    ).toThrow();
    expect(() => decodeManifest({ ...manifestFor([linuxArtifact]), requiredMatrix: [] })).toThrow();
    expect(() =>
      decodeManifest({
        ...manifestFor([linuxArtifact]),
        requiredMatrix: [
          requirementFor(linuxArtifact),
          {
            targetTriple: "aarch64-unknown-linux-gnu",
            os: "linux",
            architecture: "aarch64",
            format: "tar.gz",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a linked filename reused by different artifact records", () => {
    const arm64 = {
      ...linuxArtifact,
      architecture: "aarch64",
      targetTriple: "aarch64-unknown-linux-gnu",
      downloadName: "bibcode-server-linux-aarch64.tar.gz",
      signatureName: "bibcode-server-linux-aarch64.tar.gz.minisig",
    } as const;

    expect(() => decodeManifest(manifestFor([linuxArtifact, arm64]))).toThrow();
  });

  it("rejects stable Windows artifacts without verified Authenticode state", () => {
    const windows = {
      ...linuxArtifact,
      os: "windows",
      targetTriple: "x86_64-pc-windows-msvc",
      format: "msi",
      downloadName: "bibcode-server-x86_64.msi",
      signatureName: "bibcode-server-x86_64.msi.minisig",
      sbomName: "bibcode-server-x86_64-msi.cdx.json",
    } as const;
    expect(() => decodeManifest(manifestFor([windows], "stable"))).toThrow();
    expect(
      decodeManifest(
        manifestFor(
          [
            {
              ...windows,
              nativeSigning: {
                binary: "authenticode",
                package: "authenticode",
                verified: true,
              },
            },
          ],
          "stable",
        ),
      ).artifacts,
    ).toHaveLength(1);
  });

  it("requires both native slices before accepting a universal macOS package", () => {
    const universal = {
      ...linuxArtifact,
      os: "macos",
      architecture: "universal",
      targetTriple: "universal-apple-darwin",
      format: "pkg",
      downloadName: "bibcode-server-universal.pkg",
      signatureName: "bibcode-server-universal.pkg.minisig",
      sbomName: "bibcode-server-universal.cdx.json",
      nativeSigning: { binary: "adhoc", package: "none", verified: false },
    } as const;
    expect(() => decodeManifest(manifestFor([universal]))).toThrow();

    const x64 = {
      ...linuxArtifact,
      os: "macos",
      targetTriple: "x86_64-apple-darwin",
      downloadName: "bibcode-server-macos-x86_64.tar.gz",
      signatureName: "bibcode-server-macos-x86_64.tar.gz.minisig",
      sbomName: "bibcode-server-macos-x86_64.cdx.json",
      nativeSigning: { binary: "adhoc", package: "none", verified: false },
    } as const;
    const arm64 = {
      ...x64,
      architecture: "aarch64",
      targetTriple: "aarch64-apple-darwin",
      downloadName: "bibcode-server-macos-aarch64.tar.gz",
      signatureName: "bibcode-server-macos-aarch64.tar.gz.minisig",
      sbomName: "bibcode-server-macos-aarch64.cdx.json",
    } as const;
    expect(decodeManifest(manifestFor([x64, arm64, universal])).artifacts).toHaveLength(3);
  });

  it("rejects record identity drift and a selection outside preferred formats", () => {
    expect(() => decodeManifest(manifestFor([{ ...linuxArtifact, version: "0.4.1" }]))).toThrow();
    expect(() =>
      decodeSelection({
        target: {
          product: "bibcode-server",
          version: "0.4.2",
          os: "linux",
          architecture: "x86_64",
          preferredFormats: ["deb"],
        },
        artifact: linuxArtifact,
      }),
    ).toThrow();
  });
});
