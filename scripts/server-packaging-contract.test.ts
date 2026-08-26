// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  parseServerArtifactCliArgs,
  resolveServerArtifactBuildPlan,
} from "./build-server-artifact.ts";
import {
  collectInstallerPayload,
  generateWixFilesFragment,
  renderDebCargoManifest,
  renderMacDistribution,
  renderRpmMetadata,
  resolveLinuxNativePackageCommands,
  resolveNativeInstallerDescriptor,
  validateMacPackagePayloadListing,
} from "./lib/server-native-packaging.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");

const read = (relative: string): string =>
  NodeFS.readFileSync(NodePath.join(repoRoot, relative), "utf8");

const expectNoUnsafeInstallerPolicy = (contents: string): void => {
  expect(contents).not.toMatch(/0\.0\.0\.0|::0|firewall|netsh|ufw|firewall-cmd/iu);
  expect(contents).not.toMatch(/telemetry|posthog|sentry|BiBCode Connect|BIBCODE_RELAY/iu);
  expect(contents).not.toMatch(/rm\s+-rf|RemoveFolderEx|DeleteServices/iu);
  expect(contents).not.toMatch(/\beval\b|\b(?:ba)?sh\s+-c\b/iu);
};

describe("server installer source contract", () => {
  it("maps every native target to exact package architecture names", () => {
    expect(resolveNativeInstallerDescriptor("x86_64-pc-windows-msvc")).toEqual({
      formats: ["msi"],
      manifestArchitecture: "x86_64",
      packageArchitectures: { msi: "x64" },
    });
    expect(resolveNativeInstallerDescriptor("aarch64-pc-windows-msvc")).toEqual({
      formats: ["msi"],
      manifestArchitecture: "aarch64",
      packageArchitectures: { msi: "arm64" },
    });
    expect(resolveNativeInstallerDescriptor("aarch64-apple-darwin")).toEqual({
      formats: ["pkg"],
      manifestArchitecture: "universal",
      packageArchitectures: { pkg: "universal" },
    });
    expect(resolveNativeInstallerDescriptor("x86_64-unknown-linux-gnu")).toEqual({
      formats: ["deb", "rpm"],
      manifestArchitecture: "x86_64",
      packageArchitectures: { deb: "amd64", rpm: "x86_64" },
    });
    expect(resolveNativeInstallerDescriptor("aarch64-unknown-linux-gnu")).toEqual({
      formats: ["deb", "rpm"],
      manifestArchitecture: "aarch64",
      packageArchitectures: { deb: "arm64", rpm: "aarch64" },
    });
  });

  it("generates deterministic WiX components from a plain staged layout", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-wix-payload-"));
    NodeFS.mkdirSync(NodePath.join(root, "bin"));
    NodeFS.mkdirSync(NodePath.join(root, "share/bibcode"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, "README.md"), "readme");
    NodeFS.writeFileSync(NodePath.join(root, "bin/bibcode.exe"), "binary");
    NodeFS.writeFileSync(NodePath.join(root, "share/bibcode/LICENSE"), "license");

    const payload = await collectInstallerPayload(root, "bibcode.exe");
    const first = generateWixFilesFragment(root, payload);
    const second = generateWixFilesFragment(root, payload.toReversed());

    expect(first).toBe(second);
    expect(first).toContain('ComponentGroup Id="ServerFiles"');
    expect(first).toContain('File Id="BibcodeExecutable"');
    expect(first).toContain('Subdirectory="bin"');
    expect(first).toContain('Subdirectory="share\\bibcode"');
    expect(first).not.toContain('Guid="{00000000');
  });

  it("renders consumed macOS, DEB, and RPM inputs with no unresolved placeholder", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-native-payload-"));
    NodeFS.mkdirSync(NodePath.join(root, "bin"));
    NodeFS.mkdirSync(NodePath.join(root, "share/bibcode"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, "README.md"), "readme");
    NodeFS.writeFileSync(NodePath.join(root, "bin/bibcode"), "binary", { mode: 0o755 });
    NodeFS.writeFileSync(NodePath.join(root, "share/bibcode/LICENSE"), "license");
    const payload = await collectInstallerPayload(root, "bibcode");
    const mac = renderMacDistribution(read("packaging/server/macos/Distribution.xml"), "0.4.1");
    const deb = renderDebCargoManifest({
      payloadRoot: root,
      payload,
      version: "0.4.1",
      maintainerScripts: NodePath.join(repoRoot, "packaging/server/linux/deb"),
    });
    const rpm = renderRpmMetadata({
      template: read("packaging/server/linux/rpm/metadata.toml"),
      payloadRoot: root,
      payload,
      scripts: {
        postInstall: NodePath.join(repoRoot, "packaging/server/linux/rpm/post_install"),
        preUninstall: NodePath.join(repoRoot, "packaging/server/linux/rpm/pre_uninstall"),
        postUninstall: NodePath.join(repoRoot, "packaging/server/linux/rpm/post_uninstall"),
      },
    });

    expect(mac).toContain('version="0.4.1"');
    expect(deb).toContain('dest = "usr/bin/bibcode"');
    expect(deb).toContain('dest = "usr/share/bibcode/LICENSE"');
    expect(rpm).toContain('dest = "/usr/bin/bibcode"');
    expect(rpm).toContain('dest = "/usr/share/bibcode/LICENSE"');
    expect(rpm).not.toContain("auto-req");
    expect(`${mac}\n${deb}\n${rpm}`).not.toMatch(/@[A-Z][A-Z_]+@/u);
  });

  it("uses each Linux package tool's supported manifest and architecture arguments", () => {
    const commands = resolveLinuxNativePackageCommands({
      manifestPath: "/tmp/native/Cargo.toml",
      target: "x86_64-unknown-linux-gnu",
      debOutputPath: "/tmp/output/bibcode.deb",
      rpmOutputPath: "/tmp/output/bibcode.rpm",
      rpmArchitecture: "x86_64",
    });

    expect(commands.debArgs).toEqual([
      "deb",
      "--manifest-path",
      "/tmp/native/Cargo.toml",
      "--no-build",
      "--no-strip",
      "--target",
      "x86_64-unknown-linux-gnu",
      "--output",
      "/tmp/output/bibcode.deb",
    ]);
    expect(commands.rpmArgs).toEqual([
      "generate-rpm",
      "--target",
      "x86_64-unknown-linux-gnu",
      "--arch",
      "x86_64",
      "-o",
      "/tmp/output/bibcode.rpm",
    ]);
  });

  it("authors a pinned per-user WiX 7 MSI with owned PATH and service rollback", () => {
    const project = read("packaging/server/windows/BiBCode.Server.wixproj");
    const product = read("packaging/server/windows/Product.wxs");
    const variables = read("packaging/server/windows/variables.wxi");

    expect(project).toContain('Sdk="WixToolset.Sdk/7.0.0"');
    expect(project).toContain("InstallerPlatform");
    expect(product).toContain('Scope="perUser"');
    expect(product).toContain('Id="LocalAppDataFolder"');
    expect(product).toContain('Name="BiBCode Server"');
    expect(product).toContain('Name="PATH"');
    expect(product).toContain('System="no"');
    expect(product).toContain('Permanent="no"');
    expect(product).toContain('FileRef="BibcodeExecutable"');
    expect(product).toMatch(/service install[^"\n]*--mode workstation/iu);
    expect(product).toMatch(/service uninstall[^"\n]*--mode workstation/iu);
    expect(product).toContain('Execute="rollback"');
    expect(product).toContain('Impersonate="yes"');
    expect(product).toContain('HideTarget="yes"');
    expect(product).toContain("WIX_UPGRADE_DETECTED");
    expect(variables).toContain('UpgradeCode = "{42B72C90-DAEF-48D7-85F3-411784524876}"');
    expectNoUnsafeInstallerPolicy(`${project}\n${product}\n${variables}`);
  });

  it("authors a universal macOS product package with safe files-only fallback", () => {
    const distribution = read("packaging/server/macos/Distribution.xml");
    const preinstall = read("packaging/server/macos/scripts/preinstall");
    const postinstall = read("packaging/server/macos/scripts/postinstall");
    const combined = `${distribution}\n${preinstall}\n${postinstall}`;

    expect(distribution).toContain("com.bibcode.server");
    expect(distribution).toContain("arm64,x86_64");
    expect(preinstall).toContain("/usr/local/libexec/bibcode-server/bin/bibcode");
    expect(preinstall).toMatch(/service stop[^\n]*--mode workstation/iu);
    expect(postinstall).toContain("/dev/console");
    expect(postinstall).toContain("launchctl asuser");
    expect(postinstall).toMatch(/service install[^\n]*--mode workstation[^\n]*--update/iu);
    expect(postinstall).toMatch(/files-only/iu);
    expect(postinstall).not.toMatch(/enable.*linger/iu);
    expectNoUnsafeInstallerPolicy(combined);
  });

  it("allows only paired AppleDouble metadata and rejects escaped or incomplete macOS payloads", () => {
    const required = [
      ".",
      "./usr",
      "./usr/local",
      "./usr/local/libexec",
      "./usr/local/bin/bibcode",
      "./usr/local/libexec/bibcode-server/bin/bibcode",
      "./usr/local/libexec/bibcode-server/share/bibcode/build-metadata.json",
    ].join("\n");
    expect(validateMacPackagePayloadListing(required)).toContain(
      "./usr/local/libexec/bibcode-server/bin/bibcode",
    );
    expect(validateMacPackagePayloadListing(`${required}\n./usr/local/bin/._bibcode`)).toContain(
      "./usr/local/bin/._bibcode",
    );
    expect(() =>
      validateMacPackagePayloadListing(`${required}\n./usr/local/bin/._missing`),
    ).toThrow(/forbidden payload path/iu);
    expect(() => validateMacPackagePayloadListing(`${required}\n./etc/launchd.conf`)).toThrow(
      /forbidden payload path/iu,
    );
    expect(() => validateMacPackagePayloadListing(".\n./usr\n./usr/local/bin/bibcode")).toThrow(
      /missing required payload path/iu,
    );
  });

  it("keeps the Rust-owned Linux unit loopback-only without packaging a second definition", () => {
    const unitOwner = read("apps/server/src/service/linux.rs");

    expect(unitOwner).toContain("fn render_unit");
    expect(unitOwner).toContain("--host {host}");
    expect(unitOwner).toContain("--managed-service-mode {}");
    expect(unitOwner).toContain("NoNewPrivileges=true");
    expect(unitOwner).toContain("UMask=0077");
    expect(
      NodeFS.existsSync(NodePath.join(repoRoot, "packaging/server/linux/bibcode.service")),
    ).toBe(false);
  });

  it("makes DEB/RPM package hooks files-only by default and preserves data on removal", () => {
    const files = [
      "packaging/server/linux/deb/postinst",
      "packaging/server/linux/deb/prerm",
      "packaging/server/linux/deb/postrm",
      "packaging/server/linux/rpm/metadata.toml",
      "packaging/server/linux/rpm/post_install",
      "packaging/server/linux/rpm/pre_uninstall",
      "packaging/server/linux/rpm/post_uninstall",
    ];
    const combined = files.map(read).join("\n");

    expect(combined).toContain("BIBCODE_PACKAGE_MODE");
    expect(combined).toContain("files-only");
    expect(combined).toContain("workstation");
    expect(combined).toContain("BIBCODE_PACKAGE_USER");
    expect(combined).toContain("package.metadata.generate-rpm");
    expect(combined).not.toContain("auto-req");
    expect(combined).toMatch(/service install[^\n]*--mode workstation/iu);
    expect(combined).toMatch(/service uninstall[^\n]*--mode workstation/iu);
    expect(combined).toContain("data root is preserved");
    expect(combined).not.toMatch(/loginctl\s+enable-linger/iu);
    expectNoUnsafeInstallerPolicy(combined);
  });

  it("accepts native plus portable formats without adding a signing bypass", () => {
    const input = parseServerArtifactCliArgs([
      "--target",
      "aarch64-apple-darwin",
      "--formats",
      "native,portable",
      "--output-dir",
      "release/server-local",
      "--unsigned-test",
    ]);
    expect(input).toMatchObject({
      formats: ["native", "portable"],
      unsignedTest: true,
    });
    expect(
      resolveServerArtifactBuildPlan(input, { platform: "darwin", arch: "arm64" }, repoRoot),
    ).toMatchObject({ formats: ["native", "portable"] });

    expect(() =>
      parseServerArtifactCliArgs([
        "--target",
        "aarch64-apple-darwin",
        "--formats",
        "native",
        "--output-dir",
        "release/server-local",
        "--allow-unsigned-stable",
      ]),
    ).toThrow();
  });
});
