#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This standalone release adapter owns native filesystem and process boundaries.
// @effect-diagnostics globalConsole:off - The CLI reports bounded artifact paths and failures.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import {
  requireReleaseTarget,
  type ReleaseArch,
  type ReleasePlatform,
  type ReleaseTarget,
} from "./lib/release-targets.ts";

const REPOSITORY_ROOT = NodePath.resolve(import.meta.dirname, "..");
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/;

export interface ServerArtifactInput {
  readonly platform: ReleasePlatform;
  readonly arch: ReleaseArch;
  readonly version: string;
  readonly outputDir: string;
  readonly skipBuild?: boolean;
  readonly binaryPath?: string;
  readonly webDir?: string;
  readonly verbose?: boolean;
}

export interface ServerArtifactHost {
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
}

export interface ServerArtifactPaths {
  readonly guidePath: string;
  readonly licensePath: string;
}

export interface ServerArtifactCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface ServerArtifactPlan {
  readonly target: ReleaseTarget;
  readonly version: string;
  readonly outputDir: string;
  readonly distributionRootName: string;
  readonly stagingParent: string;
  readonly stagingDir: string;
  readonly archiveName: string;
  readonly archivePath: string;
  readonly archiveCommand: ServerArtifactCommand;
  readonly binaryPath: string;
  readonly webDir: string;
  readonly guidePath: string;
  readonly licensePath: string;
  readonly skipBuild: boolean;
  readonly verbose: boolean;
  readonly buildCommands: ReadonlyArray<ServerArtifactCommand>;
}

export class ServerArtifactConfigurationError extends Error {
  override readonly name = "ServerArtifactConfigurationError";
}

function expectedHostPlatform(platform: ReleasePlatform): NodeJS.Platform {
  return platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux";
}

function expectedHostArch(arch: ReleaseArch): NodeJS.Architecture {
  return arch === "arm64" ? "arm64" : "x64";
}

function isWithin(parent: string, child: string): boolean {
  const relative = NodePath.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
}

function rejectOverlap(outputDir: string, source: string, label: string): void {
  if (isWithin(outputDir, source) || isWithin(source, outputDir)) {
    throw new ServerArtifactConfigurationError(
      `${label} and artifact output must not overlap: ${source} -> ${outputDir}`,
    );
  }
}

function executableName(target: ReleaseTarget): string {
  return target.platform === "win" ? "bibcode.exe" : "bibcode";
}

export function planServerArtifact(
  input: ServerArtifactInput,
  host: ServerArtifactHost,
  repositoryRoot = REPOSITORY_ROOT,
  paths: Partial<ServerArtifactPaths> = {},
): ServerArtifactPlan {
  if (!VERSION_PATTERN.test(input.version)) {
    throw new ServerArtifactConfigurationError(`Invalid server artifact version ${input.version}.`);
  }
  if (host.platform !== expectedHostPlatform(input.platform)) {
    throw new ServerArtifactConfigurationError(
      `${input.platform} server artifacts require ${expectedHostPlatform(input.platform)}; current host is ${host.platform}.`,
    );
  }
  if (host.arch !== expectedHostArch(input.arch)) {
    throw new ServerArtifactConfigurationError(
      `${input.arch} server artifacts require a native ${expectedHostArch(input.arch)} host; current host is ${host.arch}.`,
    );
  }

  const target = requireReleaseTarget(input.platform, input.arch);
  const outputDir = NodePath.resolve(repositoryRoot, input.outputDir);
  const binaryPath = NodePath.resolve(
    repositoryRoot,
    input.binaryPath ??
      NodePath.join("target", target.rustTarget, "release", executableName(target)),
  );
  const webDir = NodePath.resolve(repositoryRoot, input.webDir ?? "apps/web/dist");
  const guidePath = NodePath.resolve(
    repositoryRoot,
    paths.guidePath ?? "docs/user/server-installation.md",
  );
  const licensePath = NodePath.resolve(repositoryRoot, paths.licensePath ?? "LICENSE");
  for (const [source, label] of [
    [binaryPath, "Server binary"],
    [webDir, "Web directory"],
    [guidePath, "Installation guide"],
    [licensePath, "License"],
  ] as const) {
    rejectOverlap(outputDir, source, label);
  }

  const distributionRootName = `bibcode-server-v${input.version}-${target.serverOs}-${target.serverArch}`;
  const archiveName = `${distributionRootName}.${target.serverArchive}`;
  const stagingParent = NodePath.join(outputDir, "staging");
  const stagingDir = NodePath.join(stagingParent, distributionRootName);
  const archivePath = NodePath.join(outputDir, archiveName);
  const archiveArgs = [
    target.serverArchive === "zip" ? "-a" : undefined,
    target.serverArchive === "zip" ? "-cf" : "-czf",
    archivePath,
    "-C",
    stagingParent,
    distributionRootName,
  ].filter((argument): argument is string => argument !== undefined);
  const cargoArgs = [
    "build",
    "-p",
    "bibcode-server",
    "--bin",
    "bibcode",
    "--release",
    "--target",
    target.rustTarget,
  ];
  const serverBuild =
    target.platform === "win"
      ? {
          command: process.execPath,
          args: [NodePath.join(repositoryRoot, "scripts/run-msvc.mjs"), "cargo", ...cargoArgs],
        }
      : { command: "cargo", args: cargoArgs };

  return {
    target,
    version: input.version,
    outputDir,
    distributionRootName,
    stagingParent,
    stagingDir,
    archiveName,
    archivePath,
    archiveCommand: { command: "tar", args: archiveArgs },
    binaryPath,
    webDir,
    guidePath,
    licensePath,
    skipBuild: input.skipBuild ?? false,
    verbose: input.verbose ?? false,
    buildCommands: [
      { command: "vp", args: ["run", "--filter", "@bibcode/web", "build"] },
      serverBuild,
    ],
  };
}

async function walkFiles(root: string, directory = root): Promise<ReadonlyArray<string>> {
  const files: string[] = [];
  for (const entry of await NodeFS.promises.readdir(directory, { withFileTypes: true })) {
    const path = NodePath.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new ServerArtifactConfigurationError(`Server distribution contains symlink ${path}.`);
    }
    if (entry.isDirectory()) files.push(...(await walkFiles(root, path)));
    else if (entry.isFile())
      files.push(NodePath.relative(root, path).split(NodePath.sep).join("/"));
  }
  return files.toSorted();
}

export async function stageServerDistribution(
  plan: ServerArtifactPlan,
): Promise<ReadonlyArray<string>> {
  if (!NodeFS.existsSync(plan.binaryPath) || !NodeFS.statSync(plan.binaryPath).isFile()) {
    throw new ServerArtifactConfigurationError(`Server binary is missing: ${plan.binaryPath}`);
  }
  if (!NodeFS.existsSync(NodePath.join(plan.webDir, "index.html"))) {
    throw new ServerArtifactConfigurationError(
      `Server distribution requires web/index.html under ${plan.webDir}.`,
    );
  }
  for (const [source, label] of [
    [plan.guidePath, "Installation guide"],
    [plan.licensePath, "License"],
  ] as const) {
    if (!NodeFS.existsSync(source) || !NodeFS.statSync(source).isFile()) {
      throw new ServerArtifactConfigurationError(`${label} is missing: ${source}`);
    }
  }

  await NodeFS.promises.mkdir(plan.stagingParent, { recursive: true });
  if (!isWithin(plan.outputDir, plan.stagingDir)) {
    throw new ServerArtifactConfigurationError(`Unsafe staging directory ${plan.stagingDir}.`);
  }
  await NodeFS.promises.rm(plan.stagingDir, { recursive: true, force: true });
  await NodeFS.promises.mkdir(plan.stagingDir, { recursive: true });
  const stagedBinary = NodePath.join(plan.stagingDir, executableName(plan.target));
  await NodeFS.promises.copyFile(plan.binaryPath, stagedBinary);
  await NodeFS.promises.chmod(stagedBinary, 0o755);
  await NodeFS.promises.cp(plan.webDir, NodePath.join(plan.stagingDir, "web"), {
    recursive: true,
    dereference: false,
  });
  await NodeFS.promises.copyFile(plan.guidePath, NodePath.join(plan.stagingDir, "README.md"));
  await NodeFS.promises.copyFile(plan.licensePath, NodePath.join(plan.stagingDir, "LICENSE"));

  const files = await walkFiles(plan.stagingDir);
  const required = ["LICENSE", "README.md", executableName(plan.target), "web/index.html"];
  for (const path of required) {
    if (!files.includes(path)) {
      throw new ServerArtifactConfigurationError(`Server distribution is missing ${path}.`);
    }
  }
  return files;
}

function runCommand(command: ServerArtifactCommand, cwd: string, verbose: boolean): void {
  const result = NodeChildProcess.spawnSync(command.command, [...command.args], {
    cwd,
    shell: false,
    stdio: verbose ? "inherit" : ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new ServerArtifactConfigurationError(
      `${command.command} exited with ${result.status ?? 1}: ${String(result.stderr ?? "").trim()}`,
    );
  }
}

function validateArchive(plan: ServerArtifactPlan): void {
  const result = NodeChildProcess.spawnSync("tar", ["-tf", plan.archivePath], {
    shell: false,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new ServerArtifactConfigurationError(`Could not inspect ${plan.archiveName}.`);
  }
  const prefix = `${plan.distributionRootName}/`;
  const entries = String(result.stdout).split(/\r?\n/).filter(Boolean);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (
      NodePath.posix.isAbsolute(entry) ||
      entry.split("/").includes("..") ||
      (entry !== plan.distributionRootName && !entry.startsWith(prefix)) ||
      seen.has(entry)
    ) {
      throw new ServerArtifactConfigurationError(`Unsafe archive entry ${entry}.`);
    }
    seen.add(entry);
  }
}

export async function buildServerArtifact(plan: ServerArtifactPlan): Promise<string> {
  if (!plan.skipBuild) {
    for (const command of plan.buildCommands) runCommand(command, REPOSITORY_ROOT, plan.verbose);
  }
  await stageServerDistribution(plan);
  await NodeFS.promises.mkdir(plan.outputDir, { recursive: true });
  runCommand(plan.archiveCommand, REPOSITORY_ROOT, plan.verbose);
  validateArchive(plan);
  return plan.archivePath;
}

export function parseServerArtifactArguments(
  argv: ReadonlyArray<string>,
  repositoryRoot = REPOSITORY_ROOT,
): ServerArtifactInput {
  const { values } = NodeUtil.parseArgs({
    args: [...argv],
    allowPositionals: false,
    strict: true,
    options: {
      platform: { type: "string" },
      arch: { type: "string" },
      version: { type: "string" },
      "output-dir": { type: "string" },
      "skip-build": { type: "boolean" },
      "binary-path": { type: "string" },
      "web-dir": { type: "string" },
      verbose: { type: "boolean" },
    },
  });
  if (values.platform !== "mac" && values.platform !== "linux" && values.platform !== "win") {
    throw new ServerArtifactConfigurationError("--platform must be mac, linux, or win.");
  }
  if (values.arch !== "arm64" && values.arch !== "x64") {
    throw new ServerArtifactConfigurationError("--arch must be arm64 or x64.");
  }
  const target = requireReleaseTarget(values.platform, values.arch);
  const packageJson = JSON.parse(
    NodeFS.readFileSync(NodePath.join(repositoryRoot, "apps/server/package.json"), "utf8"),
  ) as { readonly version?: unknown };
  const version = typeof values.version === "string" ? values.version : packageJson.version;
  if (typeof version !== "string") {
    throw new ServerArtifactConfigurationError("Could not resolve the server package version.");
  }
  return {
    platform: values.platform,
    arch: values.arch,
    version,
    outputDir:
      typeof values["output-dir"] === "string"
        ? values["output-dir"]
        : `release/server/${target.serverOs}-${target.serverArch}`,
    ...(values["skip-build"] === true ? { skipBuild: true } : {}),
    ...(typeof values["binary-path"] === "string" ? { binaryPath: values["binary-path"] } : {}),
    ...(typeof values["web-dir"] === "string" ? { webDir: values["web-dir"] } : {}),
    ...(values.verbose === true ? { verbose: true } : {}),
  };
}

export async function runBuildServerArtifactMain(isMain: boolean): Promise<boolean> {
  if (!isMain) return false;
  const input = parseServerArtifactArguments(process.argv.slice(2));
  // oxlint-disable-next-line bibcode/no-global-process-runtime -- The standalone CLI samples the native host once and keeps planning injectable in tests.
  const hostPlatform = NodeOS.platform();
  // oxlint-disable-next-line bibcode/no-global-process-runtime -- The standalone CLI samples the native host once and keeps planning injectable in tests.
  const hostArch = NodeOS.arch();
  const plan = planServerArtifact(input, {
    platform: hostPlatform,
    arch: hostArch,
  });
  const artifact = await buildServerArtifact(plan);
  console.log(artifact);
  return true;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href
) {
  runBuildServerArtifactMain(true).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
