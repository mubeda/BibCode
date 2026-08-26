// @effect-diagnostics nodeBuiltinImport:off

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { ServerTargetTriple } from "../build-server-artifact.ts";

export interface InstallerPayloadRecord {
  readonly path: string;
  readonly sourcePath: string;
  readonly mode: "644" | "755";
}

export interface NativeInstallerDescriptor {
  readonly formats: ReadonlyArray<"deb" | "msi" | "pkg" | "rpm">;
  readonly manifestArchitecture: "aarch64" | "universal" | "x86_64";
  readonly packageArchitectures: Readonly<Record<string, string>>;
}

const descriptorByTarget = {
  "x86_64-pc-windows-msvc": {
    formats: ["msi"],
    manifestArchitecture: "x86_64",
    packageArchitectures: { msi: "x64" },
  },
  "aarch64-pc-windows-msvc": {
    formats: ["msi"],
    manifestArchitecture: "aarch64",
    packageArchitectures: { msi: "arm64" },
  },
  "x86_64-apple-darwin": {
    formats: ["pkg"],
    manifestArchitecture: "universal",
    packageArchitectures: { pkg: "universal" },
  },
  "aarch64-apple-darwin": {
    formats: ["pkg"],
    manifestArchitecture: "universal",
    packageArchitectures: { pkg: "universal" },
  },
  "x86_64-unknown-linux-gnu": {
    formats: ["deb", "rpm"],
    manifestArchitecture: "x86_64",
    packageArchitectures: { deb: "amd64", rpm: "x86_64" },
  },
  "aarch64-unknown-linux-gnu": {
    formats: ["deb", "rpm"],
    manifestArchitecture: "aarch64",
    packageArchitectures: { deb: "arm64", rpm: "aarch64" },
  },
} as const satisfies Readonly<Record<ServerTargetTriple, NativeInstallerDescriptor>>;

export function resolveNativeInstallerDescriptor(
  target: ServerTargetTriple,
): NativeInstallerDescriptor {
  return descriptorByTarget[target];
}

const byteOrder = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const safeRelativePath = (root: string, path: string): string => {
  const relative = NodePath.relative(root, path);
  if (relative === "" || relative.startsWith("..") || NodePath.isAbsolute(relative)) {
    throw new Error(`Installer payload path escapes its staging root: ${path}.`);
  }
  return relative.split(NodePath.sep).join("/");
};

export async function collectInstallerPayload(
  rootInput: string,
  executableName: "bibcode" | "bibcode.exe",
): Promise<ReadonlyArray<InstallerPayloadRecord>> {
  const root = NodePath.resolve(rootInput);
  const rootMetadata = await NodeFSP.lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("Installer payload root must be a plain directory.");
  }
  const pending = [root];
  const records: InstallerPayloadRecord[] = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) throw new Error("Installer payload traversal failed.");
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const path = NodePath.join(directory, entry.name);
      const metadata = await NodeFSP.lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Installer payload contains a symbolic link: ${path}.`);
      }
      if (metadata.isDirectory()) {
        pending.push(path);
      } else if (metadata.isFile()) {
        const relative = safeRelativePath(root, path);
        records.push({
          path: relative,
          sourcePath: path,
          mode: relative === `bin/${executableName}` ? "755" : "644",
        });
      } else {
        throw new Error(`Installer payload contains a forbidden file kind: ${path}.`);
      }
    }
  }
  records.sort((left, right) => byteOrder(left.path, right.path));
  if (records.filter((record) => record.path === `bin/${executableName}`).length !== 1) {
    throw new Error(`Installer payload must contain exactly one bin/${executableName}.`);
  }
  return records;
}

const xmlEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const stableId = (prefix: string, value: string): string =>
  `${prefix}_${NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 24)}`;

export function generateWixFilesFragment(
  rootInput: string,
  payloadInput: ReadonlyArray<InstallerPayloadRecord>,
): string {
  const root = NodePath.resolve(rootInput);
  const payload = [...payloadInput].sort((left, right) => byteOrder(left.path, right.path));
  const components = payload.map((record) => {
    const source = NodePath.resolve(record.sourcePath);
    safeRelativePath(root, source);
    const directory = NodePath.posix.dirname(record.path);
    const subdirectory =
      directory === "." ? "" : ` Subdirectory="${xmlEscape(directory.replaceAll("/", "\\"))}"`;
    const fileId =
      record.path === "bin/bibcode.exe" ? "BibcodeExecutable" : stableId("fil", record.path);
    return [
      `      <Component Id="${stableId("cmp", record.path)}" Guid="*" Directory="INSTALLFOLDER"${subdirectory}>`,
      `        <File Id="${fileId}" Source="${xmlEscape(source)}" Name="${xmlEscape(NodePath.posix.basename(record.path))}" KeyPath="yes" />`,
      "      </Component>",
    ].join("\n");
  });
  return `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs" RequiredVersion="7.0.0">
  <Fragment>
    <ComponentGroup Id="ServerFiles">
${components.join("\n")}
    </ComponentGroup>
  </Fragment>
</Wix>
`;
}

const assertVersion = (version: string): void => {
  if (!/^[0-9]+(?:\.[0-9]+){1,3}$/u.test(version)) {
    throw new Error(`Installer version is invalid: ${version}.`);
  }
};

const assertNoPlaceholder = (contents: string): string => {
  const unresolved = contents.match(/@[A-Z][A-Z_]+@/u)?.[0];
  if (unresolved !== undefined) throw new Error(`Installer template has unresolved ${unresolved}.`);
  return contents;
};

export function renderMacDistribution(template: string, version: string): string {
  assertVersion(version);
  return assertNoPlaceholder(template.replaceAll("@VERSION@", version));
}

export function renderPackageHook(template: string, version: string): string {
  assertVersion(version);
  return assertNoPlaceholder(template.replaceAll("@PACKAGE_VERSION@", version));
}

export function validateMacPackagePayloadListing(contents: string): ReadonlyArray<string> {
  const paths = contents.split(/\r?\n/u).filter(Boolean);
  const pathSet = new Set(paths);
  const unsafePath = paths.find((path) => {
    const segments = path.split("/");
    const basename = segments.at(-1) ?? "";
    if (basename.startsWith("._")) {
      segments[segments.length - 1] = basename.slice(2);
      return !pathSet.has(segments.join("/"));
    }
    return !(
      path === "." ||
      path === "./usr" ||
      path === "./usr/local" ||
      path === "./usr/local/libexec" ||
      path.startsWith("./usr/local/bin") ||
      path.startsWith("./usr/local/libexec/bibcode-server")
    );
  });
  if (unsafePath !== undefined) {
    throw new Error(`The macOS package contains a forbidden payload path: ${unsafePath}.`);
  }
  for (const requiredPath of [
    "./usr/local/bin/bibcode",
    "./usr/local/libexec/bibcode-server/bin/bibcode",
    "./usr/local/libexec/bibcode-server/share/bibcode/build-metadata.json",
  ]) {
    if (!paths.includes(requiredPath)) {
      throw new Error(`The macOS package is missing required payload path ${requiredPath}.`);
    }
  }
  return paths;
}

const tomlString = (value: string): string => JSON.stringify(value);

const linuxDestination = (path: string): string => {
  if (path === "bin/bibcode") return "usr/bin/bibcode";
  if (path === "README.md") return "usr/share/doc/bibcode-server/README.md";
  if (path.startsWith("share/bibcode/")) return `usr/${path}`;
  throw new Error(`Linux installer payload has no destination policy for ${path}.`);
};

export interface RenderDebCargoManifestInput {
  readonly payloadRoot: string;
  readonly payload: ReadonlyArray<InstallerPayloadRecord>;
  readonly version: string;
  readonly maintainerScripts: string;
}

export function renderDebCargoManifest(input: RenderDebCargoManifestInput): string {
  assertVersion(input.version);
  const assets = [...input.payload]
    .sort((left, right) => byteOrder(left.path, right.path))
    .map((record) => {
      safeRelativePath(NodePath.resolve(input.payloadRoot), NodePath.resolve(record.sourcePath));
      return `  { source = ${tomlString(NodePath.resolve(record.sourcePath))}, dest = ${tomlString(linuxDestination(record.path))}, mode = "${record.mode}" },`;
    })
    .join("\n");
  return `[package]
name = "bibcode-server-package-input"
version = "${input.version}"
edition = "2024"
license = "Apache-2.0"
description = "Private native BiBCode coding-agent server"
authors = ["BiBCode Release <release@bibcode.local>"]

[[bin]]
name = "bibcode-server-package-input"
path = "src/main.rs"

[package.metadata.deb]
name = "bibcode-server"
maintainer = "BiBCode Release <release@bibcode.local>"
section = "devel"
priority = "optional"
depends = "$auto"
maintainer-scripts = ${tomlString(NodePath.resolve(input.maintainerScripts))}
assets = [
${assets}
]
`;
}

export interface RenderRpmMetadataInput {
  readonly template: string;
  readonly payloadRoot: string;
  readonly payload: ReadonlyArray<InstallerPayloadRecord>;
  readonly scripts: {
    readonly preInstall: string;
    readonly postInstall: string;
    readonly preUninstall: string;
    readonly postUninstall: string;
  };
}

export interface LinuxNativePackageCommandInput {
  readonly manifestPath: string;
  readonly target: ServerTargetTriple;
  readonly debOutputPath: string;
  readonly rpmOutputPath: string;
  readonly rpmArchitecture: string;
}

export interface LinuxNativePackageCommands {
  readonly debArgs: ReadonlyArray<string>;
  readonly rpmArgs: ReadonlyArray<string>;
}

export function resolveLinuxNativePackageCommands(
  input: LinuxNativePackageCommandInput,
): LinuxNativePackageCommands {
  return {
    debArgs: [
      "deb",
      "--manifest-path",
      input.manifestPath,
      "--no-build",
      "--no-strip",
      "--target",
      input.target,
      "--output",
      input.debOutputPath,
    ],
    rpmArgs: [
      "generate-rpm",
      "--target",
      input.target,
      "--arch",
      input.rpmArchitecture,
      "-o",
      input.rpmOutputPath,
    ],
  };
}

export function renderRpmMetadata(input: RenderRpmMetadataInput): string {
  const assets = [...input.payload]
    .sort((left, right) => byteOrder(left.path, right.path))
    .map((record) => {
      safeRelativePath(NodePath.resolve(input.payloadRoot), NodePath.resolve(record.sourcePath));
      return `  { source = ${tomlString(NodePath.resolve(record.sourcePath))}, dest = ${tomlString(`/${linuxDestination(record.path)}`)}, mode = "${record.mode}" }`;
    })
    .join(",\n");
  return assertNoPlaceholder(
    input.template
      .replace("  # @ASSETS@", assets)
      .replaceAll("@PRE_INSTALL_SCRIPT@", NodePath.resolve(input.scripts.preInstall))
      .replaceAll("@POST_INSTALL_SCRIPT@", NodePath.resolve(input.scripts.postInstall))
      .replaceAll("@PRE_UNINSTALL_SCRIPT@", NodePath.resolve(input.scripts.preUninstall))
      .replaceAll("@POST_UNINSTALL_SCRIPT@", NodePath.resolve(input.scripts.postUninstall)),
  );
}

export function isPlainExecutable(path: string): boolean {
  const metadata = NodeFS.lstatSync(path);
  return metadata.isFile() && !metadata.isSymbolicLink() && (metadata.mode & 0o111) !== 0;
}
