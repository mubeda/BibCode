#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { HostProcessArchitecture, HostProcessPlatform } from "@bibcode/shared/hostProcess";
import * as Effect from "effect/Effect";

import {
  collectInstalledPnpmNoticePackages,
  generateThirdPartyNoticesMarkdown,
  parseCargoNoticePackages,
} from "./lib/server-notices.ts";

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024 * 1024;

interface PortableTarget {
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly portableFormat: "zip" | "tar.gz";
  readonly executableName: "bibcode" | "bibcode.exe";
}

export const SERVER_PORTABLE_TARGETS = {
  "x86_64-pc-windows-msvc": {
    platform: "win32",
    architecture: "x64",
    portableFormat: "zip",
    executableName: "bibcode.exe",
  },
  "aarch64-pc-windows-msvc": {
    platform: "win32",
    architecture: "arm64",
    portableFormat: "zip",
    executableName: "bibcode.exe",
  },
  "x86_64-apple-darwin": {
    platform: "darwin",
    architecture: "x64",
    portableFormat: "tar.gz",
    executableName: "bibcode",
  },
  "aarch64-apple-darwin": {
    platform: "darwin",
    architecture: "arm64",
    portableFormat: "tar.gz",
    executableName: "bibcode",
  },
  "x86_64-unknown-linux-gnu": {
    platform: "linux",
    architecture: "x64",
    portableFormat: "tar.gz",
    executableName: "bibcode",
  },
  "aarch64-unknown-linux-gnu": {
    platform: "linux",
    architecture: "arm64",
    portableFormat: "tar.gz",
    executableName: "bibcode",
  },
} as const satisfies Readonly<Record<string, PortableTarget>>;

export type ServerTargetTriple = keyof typeof SERVER_PORTABLE_TARGETS;

export interface ServerArtifactBuildInput {
  readonly target: string;
  readonly formats?: ReadonlyArray<string>;
  readonly outputDir?: string;
  readonly unsignedTest?: boolean;
  readonly timeoutMs?: number;
  readonly sourceSha?: string;
  readonly sourceDateEpoch?: number;
  readonly webAssetsDir?: string;
  readonly webAssetsManifest?: string;
}

export interface ServerArtifactBuildHost {
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
}

export interface ServerArtifactBuildPlan {
  readonly target: ServerTargetTriple;
  readonly portableFormat: "zip" | "tar.gz";
  readonly executableName: "bibcode" | "bibcode.exe";
  readonly outputDir: string;
  readonly repoRoot: string;
  readonly cargoTargetDirectory: string;
  readonly cargoArgs: ReadonlyArray<string>;
  readonly timeoutMs: number;
}

export interface ServerArtifactCommandPlan {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ServerArtifactCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface ServerArtifactCommandOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

interface ExecFileOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly encoding: "utf8";
  readonly maxBuffer: number;
  readonly shell: false;
  readonly signal?: AbortSignal;
  readonly timeout: number;
  readonly windowsHide: true;
}

export type ServerArtifactExecFile = (
  command: string,
  args: ReadonlyArray<string>,
  options: ExecFileOptions,
) => Promise<ServerArtifactCommandResult>;

export type ServerArtifactCommandRunner = (
  plan: ServerArtifactCommandPlan,
  options: ServerArtifactCommandOptions,
) => Promise<ServerArtifactCommandResult>;

export interface WebAssetRecord {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface WebAssetManifest {
  readonly schemaVersion: 1;
  readonly files: ReadonlyArray<WebAssetRecord>;
}

export class ServerArtifactBuildError extends Error {
  override readonly name = "ServerArtifactBuildError";
}

const fail = (message: string): never => {
  throw new ServerArtifactBuildError(message);
};

const isTargetTriple = (value: string): value is ServerTargetTriple =>
  Object.hasOwn(SERVER_PORTABLE_TARGETS, value);

const positiveInteger = (value: string | undefined, fallback: number, label: string): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return fail(`${label} must be a positive integer.`);
  }
  return parsed;
};

export function parseServerArtifactCliArgs(argv: ReadonlyArray<string>): ServerArtifactBuildInput {
  const { values } = NodeUtil.parseArgs({
    args: [...argv],
    options: {
      target: { type: "string" },
      formats: { type: "string", default: "portable" },
      "output-dir": { type: "string" },
      "unsigned-test": { type: "boolean" },
      "timeout-ms": { type: "string" },
      "source-sha": { type: "string" },
      "source-date-epoch": { type: "string" },
      "web-assets-dir": { type: "string" },
      "web-assets-manifest": { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });
  if (!values.target) return fail("--target is required.");
  const formats = (values.formats ?? "portable")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    target: values.target,
    formats,
    timeoutMs: positiveInteger(values["timeout-ms"], DEFAULT_TIMEOUT_MS, "--timeout-ms"),
    ...(values["output-dir"] ? { outputDir: values["output-dir"] } : {}),
    ...(values["unsigned-test"] === true ? { unsignedTest: true } : {}),
    ...(values["source-sha"] ? { sourceSha: values["source-sha"] } : {}),
    ...(values["source-date-epoch"]
      ? {
          sourceDateEpoch: positiveInteger(values["source-date-epoch"], 0, "--source-date-epoch"),
        }
      : {}),
    ...(values["web-assets-dir"] ? { webAssetsDir: values["web-assets-dir"] } : {}),
    ...(values["web-assets-manifest"] ? { webAssetsManifest: values["web-assets-manifest"] } : {}),
  };
}

export function resolveServerArtifactBuildPlan(
  input: ServerArtifactBuildInput,
  host: ServerArtifactBuildHost,
  repoRootInput: string,
): ServerArtifactBuildPlan {
  if (!isTargetTriple(input.target)) {
    return fail(`Unsupported server target '${input.target}'.`);
  }
  const formats = input.formats ?? ["portable"];
  if (formats.length !== 1 || formats[0] !== "portable") {
    return fail(`Unsupported server artifact format selection: ${formats.join(",") || "<empty>"}.`);
  }
  const target = SERVER_PORTABLE_TARGETS[input.target];
  if (host.platform !== target.platform || host.arch !== target.architecture) {
    return fail(
      `Server target ${input.target} requires a native ${target.platform}/${target.architecture} host; observed ${host.platform}/${host.arch}.`,
    );
  }
  const repoRoot = NodePath.resolve(repoRootInput);
  const outputDir = NodePath.resolve(repoRoot, input.outputDir ?? "release/server-local");
  const cargoTargetDirectory = NodePath.join(repoRoot, "target", input.target, "release");
  return {
    target: input.target,
    portableFormat: target.portableFormat,
    executableName: target.executableName,
    outputDir,
    repoRoot,
    cargoTargetDirectory,
    cargoArgs: [
      "build",
      "--locked",
      "--release",
      "-p",
      "bibcode-server",
      "--bin",
      "bibcode",
      "--target",
      input.target,
      "--message-format=json-render-diagnostics",
    ],
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

export function parseCargoServerExecutable(
  output: string,
  plan: Pick<ServerArtifactBuildPlan, "cargoTargetDirectory" | "executableName">,
): string {
  const matches: string[] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trimStart().startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return fail("Cargo emitted malformed JSON while discovering the server executable.");
    }
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const target = record.target as Record<string, unknown> | undefined;
    if (
      record.reason !== "compiler-artifact" ||
      target?.name !== "bibcode" ||
      !Array.isArray(target.kind) ||
      !target.kind.includes("bin")
    ) {
      continue;
    }
    if (typeof record.executable !== "string" || record.executable.length === 0) {
      return fail("Cargo's bibcode compiler artifact has no executable path.");
    }
    matches.push(NodePath.resolve(record.executable));
  }
  if (matches.length === 0) {
    return fail("Cargo output must contain exactly one bibcode binary compiler artifact.");
  }
  if (matches.length > 1) {
    return fail("Cargo output contains a duplicate bibcode binary compiler artifact.");
  }
  const executable = matches[0] ?? fail("Cargo executable discovery failed.");
  const relative = NodePath.relative(NodePath.resolve(plan.cargoTargetDirectory), executable);
  if (relative.startsWith("..") || NodePath.isAbsolute(relative)) {
    return fail("Cargo's server executable is outside the requested target directory.");
  }
  if (NodePath.basename(executable) !== plan.executableName) {
    return fail(
      `Cargo emitted the wrong server executable name: ${NodePath.basename(executable)}.`,
    );
  }
  return executable;
}

const sha256File = async (path: string): Promise<string> => {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

const forbiddenWebContentMarkers = [
  "@tauri-apps/api",
  "__TAURI__",
  "__TAURI_INTERNALS__",
  "__TAURI_TO_IPC_KEY__",
  "tauri://",
] as const;

const sha256WebFile = async (path: string): Promise<string> => {
  const hash = NodeCrypto.createHash("sha256");
  const longestMarker = Math.max(...forbiddenWebContentMarkers.map((marker) => marker.length));
  let overlap = "";
  for await (const chunk of NodeFS.createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(bytes);
    const text = overlap + bytes.toString("utf8");
    const marker = forbiddenWebContentMarkers.find((candidate) => text.includes(candidate));
    if (marker !== undefined) {
      return fail(`Web assets contain a forbidden Tauri runtime marker: ${marker}.`);
    }
    overlap = text.slice(-(longestMarker - 1));
  }
  return hash.digest("hex");
};

const forbiddenWebPath = (relative: string): boolean => {
  const lower = relative.toLocaleLowerCase("en-US");
  const segments = lower.split("/");
  const basename = segments.at(-1) ?? "";
  return (
    segments.includes("node_modules") ||
    segments.includes(".git") ||
    segments.includes("secrets") ||
    segments.some((segment) => segment.includes("tauri")) ||
    basename === "node" ||
    basename === "node.exe" ||
    basename === "npm" ||
    basename === "npm.cmd" ||
    basename === "pnpm" ||
    basename === "pnpm.cmd" ||
    basename === ".env" ||
    basename.startsWith(".env.") ||
    basename.endsWith(".map") ||
    basename.endsWith(".log") ||
    basename.endsWith(".db") ||
    basename.endsWith(".sqlite") ||
    basename.endsWith(".sqlite3") ||
    basename.endsWith(".pem") ||
    basename.endsWith(".key")
  );
};

const byteOrder = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

export async function collectWebAssetManifest(rootInput: string): Promise<WebAssetManifest> {
  const root = NodePath.resolve(rootInput);
  const rootMetadata = await NodeFSP.lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    return fail("The web asset root must be a plain directory, not a symbolic link.");
  }
  const pending = [root];
  const files: WebAssetRecord[] = [];
  while (pending.length > 0) {
    const directory = pending.pop() ?? fail("Web asset traversal failed.");
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const path = NodePath.join(directory, entry.name);
      const metadata = await NodeFSP.lstat(path);
      if (metadata.isSymbolicLink()) {
        return fail(`Web assets contain a symbolic link: ${NodePath.relative(root, path)}.`);
      }
      if (metadata.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!metadata.isFile()) {
        return fail(`Web assets contain a forbidden file kind: ${NodePath.relative(root, path)}.`);
      }
      const relative = NodePath.relative(root, path).split(NodePath.sep).join("/");
      if (forbiddenWebPath(relative)) {
        return fail(`Web assets contain a forbidden production path: ${relative}.`);
      }
      files.push({ path: relative, size: metadata.size, sha256: await sha256WebFile(path) });
    }
  }
  files.sort((left, right) => byteOrder(left.path, right.path));
  if (!files.some((file) => file.path === "index.html")) {
    return fail("Web assets are missing index.html.");
  }
  return { schemaVersion: 1, files };
}

export async function verifyWebAssetManifest(
  root: string,
  expected: WebAssetManifest,
): Promise<void> {
  if (expected.schemaVersion !== 1 || !Array.isArray(expected.files)) {
    return fail("The web asset manifest schema is invalid.");
  }
  const actual = await collectWebAssetManifest(root);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    return fail("The immutable web asset input failed integrity verification.");
  }
}

const defaultExecFile: ServerArtifactExecFile = (command, args, options) =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      options,
      (
        error: NodeChildProcess.ExecException | null,
        stdout: string | Buffer,
        stderr: string | Buffer,
      ) => {
        if (error) {
          reject(error);
        } else {
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        }
      },
    );
  });

export async function runBoundedCommand(
  plan: ServerArtifactCommandPlan,
  options: ServerArtifactCommandOptions,
  execFile: ServerArtifactExecFile = defaultExecFile,
): Promise<ServerArtifactCommandResult> {
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new ServerArtifactBuildError("Server artifact build aborted.");
  }
  try {
    return await execFile(plan.command, plan.args, {
      cwd: plan.cwd,
      ...(plan.env ? { env: plan.env } : {}),
      encoding: "utf8",
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      shell: false,
      ...(options.signal ? { signal: options.signal } : {}),
      timeout: options.timeoutMs,
      windowsHide: true,
    });
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new ServerArtifactBuildError("Server artifact build aborted.");
    }
    if (
      error instanceof Error &&
      (("code" in error && error.code === "ETIMEDOUT") ||
        ("killed" in error && error.killed === true && "signal" in error))
    ) {
      return fail(`Server artifact command timed out: ${NodePath.basename(plan.command)}.`);
    }
    throw error;
  }
}

const assertPlainFile = (path: string, label: string): void => {
  let metadata: NodeFS.Stats;
  try {
    metadata = NodeFS.lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return fail(`${label} is missing: ${path}.`);
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail(`${label} must be a plain file: ${path}.`);
  }
};

const copyPlainTree = async (source: string, destination: string): Promise<void> => {
  const manifest = await collectWebAssetManifest(source);
  await NodeFSP.mkdir(destination, { recursive: true });
  for (const file of manifest.files) {
    const target = NodePath.join(destination, ...file.path.split("/"));
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.copyFile(NodePath.join(source, ...file.path.split("/")), target);
  }
};

const readJson = <A>(path: string): A => JSON.parse(NodeFS.readFileSync(path, "utf8")) as A;

const safeSourceSha = (value: string): string => {
  if (!/^[a-f0-9]{40}$/u.test(value))
    return fail("The release source SHA must be 40 lowercase hex characters.");
  return value;
};

const detectHost = (env: NodeJS.ProcessEnv): ServerArtifactBuildHost => {
  const [platform, detectedArchitecture] = Effect.runSync(
    Effect.all([HostProcessPlatform, HostProcessArchitecture]),
  );
  let arch = detectedArchitecture;
  if (
    platform === "win32" &&
    arch === "x64" &&
    (env.PROCESSOR_ARCHITEW6432 ?? env.PROCESSOR_ARCHITECTURE)?.toUpperCase().includes("ARM64")
  ) {
    arch = "arm64";
  }
  return { platform, arch };
};

export interface BuildServerArtifactOptions {
  readonly repoRoot?: string;
  readonly host?: ServerArtifactBuildHost;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly commandRunner?: ServerArtifactCommandRunner;
}

export interface BuiltServerArtifact {
  readonly archivePath: string;
  readonly metadataPath: string;
}

const portableReadme = (version: string): string => `# BiBCode Server ${version}

This portable archive changes no service, login item, firewall rule, data directory, or PATH when extracted.

Run in the foreground:

\`\`\`sh
./bin/bibcode serve --no-browser
\`\`\`

Register an explicit per-user workstation service:

\`\`\`sh
./bin/bibcode service install --mode workstation
\`\`\`
`;

export async function buildServerArtifact(
  input: ServerArtifactBuildInput,
  options: BuildServerArtifactOptions = {},
): Promise<BuiltServerArtifact> {
  const env = options.env ?? process.env;
  const repoRoot = NodePath.resolve(
    options.repoRoot ?? NodeURL.fileURLToPath(new URL("..", import.meta.url)),
  );
  const plan = resolveServerArtifactBuildPlan(input, options.host ?? detectHost(env), repoRoot);
  if (NodeFS.existsSync(plan.outputDir)) {
    return fail(`Server artifact output already exists: ${plan.outputDir}.`);
  }
  const requiredInputs = [
    "Cargo.lock",
    "pnpm-lock.yaml",
    "LICENSE",
    "apps/server/package.json",
    "apps/server/Cargo.toml",
    "packaging/server/common/install-layout.json",
  ].map((relative) => NodePath.join(repoRoot, relative));
  for (const path of requiredInputs) assertPlainFile(path, "Required frozen build input");
  if (Boolean(input.webAssetsDir) !== Boolean(input.webAssetsManifest)) {
    return fail("--web-assets-dir and --web-assets-manifest must be provided together.");
  }

  const commandRunner: ServerArtifactCommandRunner =
    options.commandRunner ?? ((command, limits) => runBoundedCommand(command, limits));
  const limits: ServerArtifactCommandOptions = {
    timeoutMs: plan.timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const outputParent = NodePath.dirname(plan.outputDir);
  await NodeFSP.mkdir(outputParent, { recursive: true });
  const temporary = await NodeFSP.mkdtemp(
    NodePath.join(outputParent, `.${NodePath.basename(plan.outputDir)}.staging-`),
  );
  try {
    const packageJson = readJson<{ readonly version?: unknown }>(
      NodePath.join(repoRoot, "apps/server/package.json"),
    );
    if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
      return fail("apps/server/package.json has no release version.");
    }
    const version = packageJson.version;
    const layout = readJson<{ readonly packageVersion?: unknown }>(
      NodePath.join(repoRoot, "packaging/server/common/install-layout.json"),
    );
    if (layout.packageVersion !== version) {
      return fail("The installed-layout package version is stale.");
    }

    const sourceSha = safeSourceSha(
      input.sourceSha ??
        (
          await commandRunner(
            { command: "git", args: ["rev-parse", "HEAD"], cwd: repoRoot },
            limits,
          )
        ).stdout.trim(),
    );
    const sourceDateEpoch =
      input.sourceDateEpoch ??
      positiveInteger(
        (
          await commandRunner(
            { command: "git", args: ["show", "-s", "--format=%ct", sourceSha], cwd: repoRoot },
            limits,
          )
        ).stdout.trim(),
        0,
        "source commit timestamp",
      );

    const webRoot = NodePath.join(temporary, "web");
    const webManifestPath = NodePath.join(temporary, "web-assets.json");
    if (input.webAssetsDir && input.webAssetsManifest) {
      const externalRoot = NodePath.resolve(repoRoot, input.webAssetsDir);
      const externalManifestPath = NodePath.resolve(repoRoot, input.webAssetsManifest);
      assertPlainFile(externalManifestPath, "Immutable web asset manifest");
      const externalManifest = readJson<WebAssetManifest>(externalManifestPath);
      await verifyWebAssetManifest(externalRoot, externalManifest);
      await copyPlainTree(externalRoot, webRoot);
      await NodeFSP.copyFile(externalManifestPath, webManifestPath);
    } else {
      await commandRunner(
        {
          command: "vp",
          args: ["run", "--filter", "@bibcode/web", "build:server-assets"],
          cwd: repoRoot,
        },
        limits,
      );
      await commandRunner(
        {
          command: process.execPath,
          args: ["scripts/apply-web-brand-assets.ts", "production", "apps/web/dist"],
          cwd: repoRoot,
        },
        limits,
      );
      await copyPlainTree(NodePath.join(repoRoot, "apps/web/dist"), webRoot);
      const manifest = await collectWebAssetManifest(webRoot);
      await NodeFSP.writeFile(webManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    await verifyWebAssetManifest(webRoot, readJson<WebAssetManifest>(webManifestPath));

    const [cargoMetadata, rustc] = await Promise.all([
      commandRunner(
        {
          command: "cargo",
          args: ["metadata", "--locked", "--format-version", "1", "--filter-platform", plan.target],
          cwd: repoRoot,
        },
        limits,
      ),
      commandRunner({ command: "rustc", args: ["--version", "--verbose"], cwd: repoRoot }, limits),
    ]);
    const notices = generateThirdPartyNoticesMarkdown([
      ...parseCargoNoticePackages(cargoMetadata.stdout),
      ...collectInstalledPnpmNoticePackages(NodePath.join(repoRoot, "apps/web/package.json")),
    ]);
    const noticesPath = NodePath.join(temporary, "THIRD-PARTY-NOTICES.md");
    await NodeFSP.writeFile(noticesPath, notices);

    const cargoBuild = await commandRunner(
      { command: "cargo", args: plan.cargoArgs, cwd: repoRoot },
      limits,
    );
    const executable = parseCargoServerExecutable(cargoBuild.stdout, plan);
    assertPlainFile(executable, "Cargo server executable");
    const versionOutput = await commandRunner(
      { command: executable, args: ["--version"], cwd: repoRoot },
      limits,
    );
    if (!versionOutput.stdout.split(/\s+/u).includes(version)) {
      return fail(`The built server executable does not report version ${version}.`);
    }
    const binarySha256 = await sha256File(executable);
    const metadata = {
      schemaVersion: 1,
      product: "bibcode-server",
      buildMode: input.unsignedTest === true ? "unsigned-test" : "signing-candidate",
      version,
      sourceSha,
      targetTriple: plan.target,
      sourceDateEpoch,
      rustc: rustc.stdout.trim(),
      binarySha256,
    } as const;
    const metadataPath = NodePath.join(temporary, "build-metadata.json");
    await NodeFSP.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    const readmePath = NodePath.join(temporary, "README.md");
    await NodeFSP.writeFile(readmePath, portableReadme(version));

    const stagedRoot = NodePath.join(temporary, "stage", "bibcode-server");
    await commandRunner(
      {
        command: "cargo",
        args: [
          "run",
          "--locked",
          "-p",
          "bibcode-server-packager",
          "--",
          "stage",
          "--binary",
          executable,
          "--web-root",
          webRoot,
          "--web-asset-manifest",
          webManifestPath,
          "--install-layout",
          NodePath.join(repoRoot, "packaging/server/common/install-layout.json"),
          "--license",
          NodePath.join(repoRoot, "LICENSE"),
          "--notices",
          noticesPath,
          "--portable-readme",
          readmePath,
          "--build-metadata",
          metadataPath,
          "--output",
          stagedRoot,
        ],
        cwd: repoRoot,
      },
      limits,
    );

    const publish = NodePath.join(temporary, "publish");
    await NodeFSP.mkdir(publish);
    const suffix = plan.portableFormat;
    const archiveName = `bibcode-server-${version}-${plan.target}.${suffix}`;
    const archivePath = NodePath.join(publish, archiveName);
    await commandRunner(
      {
        command: "cargo",
        args: [
          "run",
          "--locked",
          "-p",
          "bibcode-server-packager",
          "--",
          "archive",
          "--input",
          stagedRoot,
          "--output",
          archivePath,
          "--format",
          plan.portableFormat === "tar.gz" ? "tar-gz" : "zip",
          "--source-date-epoch",
          String(sourceDateEpoch),
        ],
        cwd: repoRoot,
      },
      limits,
    );
    assertPlainFile(archivePath, "Portable server archive");
    const publishedMetadata = NodePath.join(publish, `${archiveName}.build.json`);
    await NodeFSP.copyFile(metadataPath, publishedMetadata);
    await NodeFSP.rename(publish, plan.outputDir);
    return {
      archivePath: NodePath.join(plan.outputDir, archiveName),
      metadataPath: NodePath.join(plan.outputDir, NodePath.basename(publishedMetadata)),
    };
  } finally {
    await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
}

export async function runBuildServerArtifactMain(
  argv: ReadonlyArray<string> = process.argv.slice(2),
): Promise<void> {
  const result = await buildServerArtifact(parseServerArtifactCliArgs(argv));
  process.stdout.write(`${result.archivePath}\n${result.metadataPath}\n`);
}

const invokedPath = process.argv[1] ? NodePath.resolve(process.argv[1]) : undefined;
if (invokedPath && NodeURL.pathToFileURL(invokedPath).href === import.meta.url) {
  runBuildServerArtifactMain().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Server build failed."}\n`);
    process.exitCode = 1;
  });
}
