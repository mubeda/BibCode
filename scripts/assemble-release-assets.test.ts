// @effect-diagnostics nodeBuiltinImport:off - This assembler test uses real temporary release fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  ReleaseAssetAssemblyError,
  assembleReleaseAssets,
  expectedSymbolAssetNames,
} from "./assemble-release-assets.ts";
import {
  buildTauriUpdateManifest,
  serializeTauriUpdateManifest,
} from "./build-tauri-update-manifest.ts";

const TEST_MINISIGN_SIGNATURE =
  "untrusted comment: signature from minisign secret key\n" +
  "RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\n" +
  "trusted comment: timestamp:1556193335\tfile:test\n" +
  "y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==\n";
const TEST_SIGNATURE = Buffer.from(TEST_MINISIGN_SIGNATURE).toString("base64");

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-release-assets-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

function desktopInstallersFor(version: string): ReadonlyArray<string> {
  return [
    `BiBCode_${version}_aarch64.dmg`,
    `BiBCode_${version}_x64.dmg`,
    `BiBCode_${version}_aarch64.AppImage`,
    `BiBCode_${version}_amd64.AppImage`,
    `BiBCode_${version}_arm64-setup.exe`,
    `BiBCode_${version}_x64-setup.exe`,
  ];
}

function updaterArtifactFor(target: string, version: string): string {
  if (target.startsWith("darwin-")) return `bibcode-update-${target}.app.tar.gz`;
  if (target === "linux-aarch64") return `BiBCode_${version}_aarch64.AppImage`;
  if (target === "linux-x86_64") return `BiBCode_${version}_amd64.AppImage`;
  if (target === "windows-aarch64") return `BiBCode_${version}_arm64-setup.exe`;
  return `BiBCode_${version}_x64-setup.exe`;
}

function writeDesktopFixture(root: string, version: string, updater: boolean): void {
  for (const name of [...desktopInstallersFor(version), ...expectedSymbolAssetNames(version)]) {
    NodeFS.writeFileSync(NodePath.join(root, name), name);
  }
  if (updater) {
    for (const target of [
      "darwin-aarch64",
      "darwin-x86_64",
      "linux-aarch64",
      "linux-x86_64",
      "windows-aarch64",
      "windows-x86_64",
    ]) {
      const artifact = updaterArtifactFor(target, version);
      NodeFS.writeFileSync(
        NodePath.join(root, `updater-${target}.json`),
        `${JSON.stringify({ target, artifact, signature: `${artifact}.sig` })}\n`,
      );
      NodeFS.writeFileSync(NodePath.join(root, artifact), artifact);
      NodeFS.writeFileSync(NodePath.join(root, `${artifact}.sig`), `${TEST_SIGNATURE}\n`);
    }
  }
}

effectIt.layer(NodeServices.layer)("stable manifest and desktop release asset assembly", (it) => {
  it.effect(
    "assembles a full stable release from staged installers, symbols, and generated latest.json",
    () =>
      Effect.gen(function* () {
        const root = temporaryRoot();
        writeDesktopFixture(root, "0.4.3", true);

        const manifest = yield* buildTauriUpdateManifest({
          assetsDir: root,
          version: "0.4.3",
          tag: "v0.4.3",
          repository: "mubeda/BibCode",
          pubDate: "2026-07-24T12:00:00Z",
          notes: "BiBCode v0.4.3",
        });
        NodeFS.writeFileSync(
          NodePath.join(root, "latest.json"),
          serializeTauriUpdateManifest(manifest),
        );

        const result = yield* Effect.promise(() =>
          assembleReleaseAssets({
            assetsDir: root,
            version: "0.4.3",
            updater: true,
          }),
        );

        expect(NodeFS.existsSync(NodePath.join(root, "latest.json"))).toBe(true);
        expect(NodeFS.readdirSync(root).some((name) => name.startsWith("updater-"))).toBe(false);
        expect(NodeFS.existsSync(NodePath.join(root, "bibcode-server-SHA256SUMS"))).toBe(false);
        expect(NodeFS.readdirSync(root).some((name) => name.endsWith(".minisig"))).toBe(false);
        expect(result.publishedAssets).toHaveLength(21);
        expect(result.publishedAssets).toContain("latest.json");
        expect(result.publishedAssets).toContain("bibcode-desktop-symbols-0.4.3-linux-x86_64.zip");
        expect(result.publishedAssets).toContain("bibcode-update-darwin-aarch64.app.tar.gz");
        expect(result.publishedAssets).toContain("bibcode-update-darwin-aarch64.app.tar.gz.sig");
      }),
  );
});

describe("release asset assembly", () => {
  it("requires six desktop symbol archives and zero server symbol archives", () => {
    const names = expectedSymbolAssetNames("0.4.3");
    expect(names).toHaveLength(6);
    for (const key of [
      "darwin-aarch64",
      "darwin-x86_64",
      "linux-aarch64",
      "linux-x86_64",
      "windows-aarch64",
      "windows-x86_64",
    ]) {
      expect(names).toContain(`bibcode-desktop-symbols-0.4.3-${key}.zip`);
      expect(names).not.toContain(`bibcode-server-symbols-0.4.3-${key}.zip`);
    }
  });

  it("assembles a prerelease or nightly release with only six installers and six desktop symbols", async () => {
    const root = temporaryRoot();
    writeDesktopFixture(root, "0.4.3-nightly.20261125.1", false);

    const result = await assembleReleaseAssets({
      assetsDir: root,
      version: "0.4.3-nightly.20261125.1",
      updater: false,
    });

    expect(result.publishedAssets).toHaveLength(12);
    expect(NodeFS.existsSync(NodePath.join(root, "latest.json"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(root, "bibcode-server-SHA256SUMS"))).toBe(false);
    expect(NodeFS.readdirSync(root).some((name) => name.endsWith(".minisig"))).toBe(false);
  });

  it.each([
    "bibcode-server-v0.4.3-linux-x86_64.tar.gz",
    "bibcode-server-v0.4.3-windows-x86_64.zip",
    "bibcode-server_0.4.3_amd64.deb",
    "bibcode-server-0.4.3-1.x86_64.rpm",
    "bibcode-server-SHA256SUMS",
    "bibcode-server-v0.4.3-linux-x86_64.tar.gz.minisig",
    "bibcode-server-symbols-0.4.3-linux-x86_64.zip",
    "stale-debug.txt",
    "stale.sig",
    "bibcode-desktop-symbols-0.4.3-linux-riscv64.zip",
  ])("rejects unlisted or standalone server release asset %s", async (forbiddenAsset) => {
    const root = temporaryRoot();
    writeDesktopFixture(root, "0.4.3", false);
    NodeFS.writeFileSync(NodePath.join(root, forbiddenAsset), "unexpected");

    const promise = assembleReleaseAssets({ assetsDir: root, version: "0.4.3", updater: false });
    await expect(promise).rejects.toBeInstanceOf(ReleaseAssetAssemblyError);
    await expect(promise).rejects.toThrow(`Unexpected release asset ${forbiddenAsset}`);
  });

  it("rejects updater descriptors pointing at misassigned target payloads or server files", async () => {
    const root = temporaryRoot();
    writeDesktopFixture(root, "0.4.3", true);
    NodeFS.writeFileSync(NodePath.join(root, "latest.json"), "{}\n");

    const misassignedArtifact = "BiBCode_0.4.3_amd64.AppImage";
    NodeFS.writeFileSync(
      NodePath.join(root, "updater-linux-aarch64.json"),
      `${JSON.stringify({
        target: "linux-aarch64",
        artifact: misassignedArtifact,
        signature: `${misassignedArtifact}.sig`,
      })}\n`,
    );

    await expect(
      assembleReleaseAssets({ assetsDir: root, version: "0.4.3", updater: true }),
    ).rejects.toThrow(/Updater artifact mismatch in updater-linux-aarch64\.json/);

    const forbiddenArtifact = "bibcode-server-v0.4.3-linux-aarch64.tar.gz";
    NodeFS.writeFileSync(NodePath.join(root, forbiddenArtifact), "server");
    NodeFS.writeFileSync(NodePath.join(root, `${forbiddenArtifact}.sig`), `${TEST_SIGNATURE}\n`);
    NodeFS.writeFileSync(
      NodePath.join(root, "updater-linux-aarch64.json"),
      `${JSON.stringify({
        target: "linux-aarch64",
        artifact: forbiddenArtifact,
        signature: `${forbiddenArtifact}.sig`,
      })}\n`,
    );

    await expect(
      assembleReleaseAssets({ assetsDir: root, version: "0.4.3", updater: true }),
    ).rejects.toThrow(/Updater artifact mismatch in updater-linux-aarch64\.json/);
  });

  it("fails naming the missing asset when a desktop installer, desktop symbol, latest.json, or updater file is absent", async () => {
    const missingInstallerRoot = temporaryRoot();
    writeDesktopFixture(missingInstallerRoot, "0.4.3", false);
    NodeFS.rmSync(NodePath.join(missingInstallerRoot, "BiBCode_0.4.3_x64-setup.exe"));
    await expect(
      assembleReleaseAssets({
        assetsDir: missingInstallerRoot,
        version: "0.4.3",
        updater: false,
      }),
    ).rejects.toThrow(/Windows x64 NSIS \(BiBCode_0\.4\.3_x64-setup\.exe\)/);

    const missingAliasInstallerRoot = temporaryRoot();
    writeDesktopFixture(missingAliasInstallerRoot, "0.4.3", false);
    NodeFS.rmSync(NodePath.join(missingAliasInstallerRoot, "BiBCode_0.4.3_aarch64.dmg"));
    await expect(
      assembleReleaseAssets({
        assetsDir: missingAliasInstallerRoot,
        version: "0.4.3",
        updater: false,
      }),
    ).rejects.toThrow(
      /macOS ARM64 DMG \(BiBCode_0\.4\.3_aarch64\.dmg or BiBCode_0\.4\.3_arm64\.dmg\)/,
    );

    const missingSymbolRoot = temporaryRoot();
    writeDesktopFixture(missingSymbolRoot, "0.4.3", false);
    NodeFS.rmSync(
      NodePath.join(missingSymbolRoot, "bibcode-desktop-symbols-0.4.3-darwin-x86_64.zip"),
    );
    await expect(
      assembleReleaseAssets({
        assetsDir: missingSymbolRoot,
        version: "0.4.3",
        updater: false,
      }),
    ).rejects.toThrow(
      "Missing symbol release asset bibcode-desktop-symbols-0.4.3-darwin-x86_64.zip",
    );

    const missingManifestRoot = temporaryRoot();
    writeDesktopFixture(missingManifestRoot, "0.4.3", true);
    await expect(
      assembleReleaseAssets({
        assetsDir: missingManifestRoot,
        version: "0.4.3",
        updater: true,
      }),
    ).rejects.toThrow("latest.json");

    const missingUpdaterSigRoot = temporaryRoot();
    writeDesktopFixture(missingUpdaterSigRoot, "0.4.3", true);
    NodeFS.writeFileSync(NodePath.join(missingUpdaterSigRoot, "latest.json"), "{}\n");
    NodeFS.rmSync(
      NodePath.join(missingUpdaterSigRoot, "bibcode-update-darwin-aarch64.app.tar.gz.sig"),
    );
    await expect(
      assembleReleaseAssets({
        assetsDir: missingUpdaterSigRoot,
        version: "0.4.3",
        updater: true,
      }),
    ).rejects.toThrow("Missing updater asset bibcode-update-darwin-aarch64.app.tar.gz.sig");
  });
});
