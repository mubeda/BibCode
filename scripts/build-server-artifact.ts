#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import type {
  NativeSigningState,
  ServerArtifactArchitecture,
  ServerArtifactFormat,
  ServerArtifactOs,
} from "@bibcode/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@bibcode/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  collectInstalledPnpmNoticePackages,
  generateThirdPartyNoticesMarkdown,
  parseCargoNoticePackages,
} from "./lib/server-notices.ts";
import {
  collectInstallerPayload,
  generateWixFilesFragment,
  isPlainExecutable,
  renderDebCargoManifest,
  renderMacDistribution,
  renderPackageHook,
  renderRpmMetadata,
  resolveLinuxNativePackageCommands,
  resolveNativeInstallerDescriptor,
  validateMacPackagePayloadListing,
} from "./lib/server-native-packaging.ts";

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
export type ServerArtifactFormatSelection = "native" | "portable";

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
  readonly macosOtherSlice?: string;
  readonly macosOtherSliceMetadata?: string;
}

export interface ServerArtifactBuildHost {
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
}

export interface ServerArtifactBuildPlan {
  readonly target: ServerTargetTriple;
  readonly formats: ReadonlyArray<ServerArtifactFormatSelection>;
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

export function parsePinnedRustToolchainChannel(contents: string): string {
  const channel = contents.match(/^\s*channel\s*=\s*"([^"]+)"\s*$/mu)?.[1];
  if (channel === undefined || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(channel)) {
    return fail("rust-toolchain.toml must pin an exact stable Rust channel.");
  }
  return channel;
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
      "macos-other-slice": { type: "string" },
      "macos-other-slice-metadata": { type: "string" },
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
    ...(values["macos-other-slice"] ? { macosOtherSlice: values["macos-other-slice"] } : {}),
    ...(values["macos-other-slice-metadata"]
      ? { macosOtherSliceMetadata: values["macos-other-slice-metadata"] }
      : {}),
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
  if (
    formats.length === 0 ||
    new Set(formats).size !== formats.length ||
    formats.some((format) => format !== "native" && format !== "portable")
  ) {
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
    formats: formats as ReadonlyArray<ServerArtifactFormatSelection>,
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

const unsignedNativeSigning = (): NativeSigningState => ({
  binary: "none",
  package: "none",
  verified: false,
  timestamped: false,
  signerSubject: null,
  signerThumbprint: null,
  teamId: null,
});

const adhocMacNativeSigning = (): NativeSigningState => ({
  ...unsignedNativeSigning(),
  binary: "adhoc",
});

export interface WindowsAuthenticodeConfiguration {
  readonly signerSubject: string;
  readonly signerThumbprint: string;
  readonly timestampUrl: string;
}

export interface MacDeveloperIdConfiguration {
  readonly applicationIdentity: string;
  readonly installerIdentity: string;
  readonly teamId: string;
  readonly notaryProfile: string;
}

const requiredTrimmedEnvironmentValue = (
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined => {
  const value = env[name];
  return value !== undefined && value.trim() === value && value.length > 0 ? value : undefined;
};

export function resolveWindowsAuthenticodeConfiguration(
  env: NodeJS.ProcessEnv,
): WindowsAuthenticodeConfiguration {
  const signerSubject = requiredTrimmedEnvironmentValue(env, "WINDOWS_SIGNING_CERTIFICATE_SUBJECT");
  const rawThumbprint = requiredTrimmedEnvironmentValue(
    env,
    "WINDOWS_SIGNING_CERTIFICATE_THUMBPRINT",
  );
  const timestampUrl = requiredTrimmedEnvironmentValue(env, "WINDOWS_SIGNING_TIMESTAMP_URL");
  const signerThumbprint = rawThumbprint?.toLocaleLowerCase("en-US");
  if (
    signerSubject === undefined ||
    signerSubject.length > 512 ||
    signerThumbprint === undefined ||
    !/^[a-f0-9]{40}$/u.test(signerThumbprint) ||
    timestampUrl === undefined
  ) {
    return fail(
      "Stable Windows server builds require an expected certificate subject, SHA-1 thumbprint, and HTTPS RFC 3161 timestamp URL.",
    );
  }
  let parsedTimestamp: URL;
  try {
    parsedTimestamp = new URL(timestampUrl);
  } catch {
    return fail("The Windows signing timestamp URL must be a valid HTTPS URL.");
  }
  if (parsedTimestamp.protocol !== "https:") {
    return fail("The Windows signing timestamp URL must be a valid HTTPS URL.");
  }
  return { signerSubject, signerThumbprint, timestampUrl: parsedTimestamp.href };
}

export function resolveMacDeveloperIdConfiguration(
  env: NodeJS.ProcessEnv,
): MacDeveloperIdConfiguration | null {
  const names = [
    "BIBCODE_SERVER_MACOS_APPLICATION_IDENTITY",
    "BIBCODE_SERVER_MACOS_INSTALLER_IDENTITY",
    "APPLE_TEAM_ID",
    "BIBCODE_SERVER_MACOS_NOTARY_PROFILE",
  ] as const;
  const values = names.map((name) => requiredTrimmedEnvironmentValue(env, name));
  if (values.every((value) => value === undefined)) return null;
  const [applicationIdentity, installerIdentity, teamId, notaryProfile] = values;
  if (
    applicationIdentity === undefined ||
    installerIdentity === undefined ||
    teamId === undefined ||
    notaryProfile === undefined ||
    !/^[A-Z0-9]{10}$/u.test(teamId) ||
    !applicationIdentity.startsWith("Developer ID Application:") ||
    !installerIdentity.startsWith("Developer ID Installer:") ||
    !applicationIdentity.endsWith(`(${teamId})`) ||
    !installerIdentity.endsWith(`(${teamId})`) ||
    !/^[A-Za-z0-9._-]+$/u.test(notaryProfile)
  ) {
    return fail(
      "Optional macOS server signing requires matching Developer ID Application/Installer identities, team ID, and a keychain notary profile.",
    );
  }
  return { applicationIdentity, installerIdentity, teamId, notaryProfile };
}

const artifactOsForTarget = (target: ServerTargetTriple): ServerArtifactOs => {
  switch (SERVER_PORTABLE_TARGETS[target].platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
  }
};

const artifactArchitectureForTarget = (
  target: ServerTargetTriple,
): Exclude<ServerArtifactArchitecture, "universal"> =>
  SERVER_PORTABLE_TARGETS[target].architecture === "arm64" ? "aarch64" : "x86_64";

const fileInventoryForPayload = async (
  root: string,
  executableName: "bibcode" | "bibcode.exe",
): Promise<ReadonlyArray<ServerBuildFileRecord>> => {
  const payload = await collectInstallerPayload(root, executableName);
  return Promise.all(
    payload.map(async ({ path, sourcePath }) => {
      const metadata = await NodeFSP.lstat(sourcePath);
      return { path, size: metadata.size, sha256: await sha256File(sourcePath) };
    }),
  );
};

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

const windowsSignatureInspectionScript = [
  "$ErrorActionPreference = 'Stop'",
  "$signature = Get-AuthenticodeSignature -LiteralPath $args[0]",
  "if ($null -eq $signature.SignerCertificate) { throw 'missing signer certificate' }",
  "[ordered]@{",
  "  status = [string]$signature.Status",
  "  subject = $signature.SignerCertificate.Subject",
  "  thumbprint = $signature.SignerCertificate.Thumbprint.ToLowerInvariant()",
  "  notBefore = $signature.SignerCertificate.NotBefore.ToUniversalTime().ToString('O')",
  "  notAfter = $signature.SignerCertificate.NotAfter.ToUniversalTime().ToString('O')",
  "} | ConvertTo-Json -Compress",
].join("\n");

interface WindowsSignatureInspection {
  readonly status: string;
  readonly subject: string;
  readonly thumbprint: string;
  readonly notBefore: string;
  readonly notAfter: string;
}

export async function signAndVerifyWindowsArtifact(input: {
  readonly path: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly commandRunner: ServerArtifactCommandRunner;
  readonly limits: ServerArtifactCommandOptions;
  readonly nowEpochMs?: number;
}): Promise<NativeSigningState> {
  assertPlainFile(input.path, "Windows signing input");
  const configuration = resolveWindowsAuthenticodeConfiguration(input.env);
  const runSensitive = async (
    plan: ServerArtifactCommandPlan,
    failure: string,
  ): Promise<ServerArtifactCommandResult> => {
    try {
      return await input.commandRunner(plan, input.limits);
    } catch {
      return fail(failure);
    }
  };
  await runSensitive(
    {
      command: "signtool",
      args: [
        "sign",
        "/sha1",
        configuration.signerThumbprint,
        "/fd",
        "SHA256",
        "/tr",
        configuration.timestampUrl,
        "/td",
        "SHA256",
        input.path,
      ],
      cwd: input.cwd,
    },
    "Windows Authenticode signing or timestamping failed.",
  );
  await runSensitive(
    {
      command: "signtool",
      args: ["verify", "/pa", "/all", "/v", input.path],
      cwd: input.cwd,
    },
    "Windows Authenticode verification failed.",
  );
  const inspectionResult = await runSensitive(
    {
      command: "pwsh",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        windowsSignatureInspectionScript,
        input.path,
      ],
      cwd: input.cwd,
    },
    "Windows Authenticode identity inspection failed.",
  );
  let inspection: WindowsSignatureInspection;
  try {
    inspection = JSON.parse(inspectionResult.stdout) as WindowsSignatureInspection;
  } catch {
    return fail("Windows Authenticode identity inspection returned invalid evidence.");
  }
  const notBefore = Date.parse(inspection.notBefore);
  const notAfter = Date.parse(inspection.notAfter);
  const now = input.nowEpochMs ?? DateTime.toEpochMillis(DateTime.nowUnsafe());
  if (
    inspection.status !== "Valid" ||
    inspection.subject !== configuration.signerSubject ||
    inspection.thumbprint !== configuration.signerThumbprint ||
    !Number.isFinite(notBefore) ||
    !Number.isFinite(notAfter) ||
    now < notBefore ||
    now > notAfter
  ) {
    return fail(
      "Windows Authenticode signer identity, validity, or verification did not match policy.",
    );
  }
  return {
    binary: "authenticode",
    package:
      NodePath.extname(input.path).toLocaleLowerCase("en-US") === ".msi" ? "authenticode" : "none",
    verified: true,
    timestamped: true,
    signerSubject: configuration.signerSubject,
    signerThumbprint: configuration.signerThumbprint,
    teamId: null,
  };
}

export async function signAndVerifyMacExecutable(input: {
  readonly path: string;
  readonly cwd: string;
  readonly configuration: MacDeveloperIdConfiguration | null;
  readonly commandRunner: ServerArtifactCommandRunner;
  readonly limits: ServerArtifactCommandOptions;
}): Promise<NativeSigningState> {
  assertPlainFile(input.path, "macOS signing input");
  const runSensitive = async (plan: ServerArtifactCommandPlan, failure: string): Promise<void> => {
    try {
      await input.commandRunner(plan, input.limits);
    } catch {
      fail(failure);
    }
  };
  const signingArgs =
    input.configuration === null
      ? ["--force", "--sign", "-", "--timestamp=none", input.path]
      : [
          "--force",
          "--options",
          "runtime",
          "--sign",
          input.configuration.applicationIdentity,
          "--timestamp",
          input.path,
        ];
  await runSensitive(
    { command: "codesign", args: signingArgs, cwd: input.cwd },
    "macOS executable signing failed.",
  );
  await runSensitive(
    {
      command: "codesign",
      args: ["--verify", "--strict", "--verbose=2", input.path],
      cwd: input.cwd,
    },
    "macOS executable signature verification failed.",
  );
  if (input.configuration === null) return adhocMacNativeSigning();
  await runSensitive(
    {
      command: "spctl",
      args: ["--assess", "--type", "execute", "--verbose=4", input.path],
      cwd: input.cwd,
    },
    "macOS Developer ID executable assessment failed.",
  );
  return {
    binary: "developer-id",
    package: "none",
    verified: true,
    timestamped: true,
    signerSubject: input.configuration.applicationIdentity,
    signerThumbprint: null,
    teamId: input.configuration.teamId,
  };
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

const resolveRustToolchainRuntime = async (
  channel: string,
  baseEnv: NodeJS.ProcessEnv,
  repoRoot: string,
  commandRunner: ServerArtifactCommandRunner,
  limits: ServerArtifactCommandOptions,
): Promise<RustToolchainRuntime> => {
  const [cargoResult, rustcResult] = await Promise.all([
    commandRunner(
      {
        command: "rustup",
        args: ["which", "--toolchain", channel, "cargo"],
        cwd: repoRoot,
      },
      limits,
    ),
    commandRunner(
      {
        command: "rustup",
        args: ["which", "--toolchain", channel, "rustc"],
        cwd: repoRoot,
      },
      limits,
    ),
  ]);
  const cargo = NodePath.resolve(cargoResult.stdout.trim());
  const rustc = NodePath.resolve(rustcResult.stdout.trim());
  if (
    !NodePath.isAbsolute(cargoResult.stdout.trim()) ||
    !NodePath.isAbsolute(rustcResult.stdout.trim())
  ) {
    return fail("rustup returned a non-absolute pinned toolchain path.");
  }
  assertPlainFile(cargo, "Pinned Cargo executable");
  assertPlainFile(rustc, "Pinned rustc executable");
  if (NodePath.dirname(cargo) !== NodePath.dirname(rustc)) {
    return fail("Pinned Cargo and rustc must come from the same Rust toolchain directory.");
  }
  return {
    cargo,
    rustc,
    env: { ...baseEnv, RUSTC: rustc, RUSTUP_TOOLCHAIN: channel },
  };
};

export const copyPlainTree = async (source: string, destination: string): Promise<void> => {
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
  readonly artifactPaths: ReadonlyArray<string>;
  readonly metadataPaths: ReadonlyArray<string>;
  readonly archivePath?: string;
  readonly metadataPath?: string;
}

interface ServerBuildMetadata {
  readonly schemaVersion: 1;
  readonly product: "bibcode-server";
  readonly buildMode: "signing-candidate" | "unsigned-test";
  readonly version: string;
  readonly sourceSha: string;
  readonly targetTriple: string;
  readonly sourceDateEpoch: number;
  readonly rustc: string;
  readonly binarySha256: string;
  readonly sliceSha256?: Readonly<Record<string, string>>;
}

interface ServerBuildFileRecord {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

interface PublishedServerBuildMetadata extends ServerBuildMetadata {
  readonly artifact: {
    readonly downloadName: string;
    readonly os: ServerArtifactOs;
    readonly architecture: ServerArtifactArchitecture;
    readonly format: ServerArtifactFormat;
    readonly nativeSigning: NativeSigningState;
    readonly notarized: boolean;
  };
  readonly fileInventory: ReadonlyArray<ServerBuildFileRecord>;
}

interface PublishedServerArtifact {
  readonly fileName: string;
  readonly metadataName: string;
}

interface RustToolchainRuntime {
  readonly cargo: string;
  readonly rustc: string;
  readonly env: NodeJS.ProcessEnv;
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

const cargoArgsForTarget = (target: ServerTargetTriple): ReadonlyArray<string> => [
  "build",
  "--locked",
  "--release",
  "-p",
  "bibcode-server",
  "--bin",
  "bibcode",
  "--target",
  target,
  "--message-format=json-render-diagnostics",
];

const writeBuildMetadata = async (path: string, metadata: ServerBuildMetadata): Promise<void> => {
  await NodeFSP.writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`);
};

interface StageServerLayoutInput {
  readonly repoRoot: string;
  readonly rust: RustToolchainRuntime;
  readonly executable: string;
  readonly webRoot: string;
  readonly webManifestPath: string;
  readonly noticesPath: string;
  readonly readmePath: string;
  readonly metadataPath: string;
  readonly output: string;
}

const stageServerLayout = async (
  input: StageServerLayoutInput,
  commandRunner: ServerArtifactCommandRunner,
  limits: ServerArtifactCommandOptions,
): Promise<void> => {
  await commandRunner(
    {
      command: input.rust.cargo,
      args: [
        "run",
        "--locked",
        "-p",
        "bibcode-server-packager",
        "--",
        "stage",
        "--binary",
        input.executable,
        "--web-root",
        input.webRoot,
        "--web-asset-manifest",
        input.webManifestPath,
        "--install-layout",
        NodePath.join(input.repoRoot, "packaging/server/common/install-layout.json"),
        "--license",
        NodePath.join(input.repoRoot, "LICENSE"),
        "--notices",
        input.noticesPath,
        "--portable-readme",
        input.readmePath,
        "--build-metadata",
        input.metadataPath,
        "--output",
        input.output,
      ],
      cwd: input.repoRoot,
      env: input.rust.env,
    },
    limits,
  );
};

const findPlainFiles = async (root: string, extension: string): Promise<ReadonlyArray<string>> => {
  const pending = [NodePath.resolve(root)];
  const matches: string[] = [];
  while (pending.length > 0) {
    const directory = pending.pop() ?? fail("Native installer output traversal failed.");
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const path = NodePath.join(directory, entry.name);
      const metadata = await NodeFSP.lstat(path);
      if (metadata.isSymbolicLink()) {
        return fail(`Native installer output contains a symbolic link: ${path}.`);
      }
      if (metadata.isDirectory()) {
        pending.push(path);
      } else if (metadata.isFile() && entry.name.endsWith(extension)) {
        matches.push(path);
      }
    }
  }
  return matches.sort((left, right) => byteOrder(left, right));
};

const requireExactlyOneOutput = async (
  root: string,
  extension: string,
  label: string,
): Promise<string> => {
  const matches = await findPlainFiles(root, extension);
  if (matches.length !== 1) {
    return fail(`${label} must produce exactly one ${extension} file; observed ${matches.length}.`);
  }
  return matches[0] ?? fail(`${label} output discovery failed.`);
};

const assertToolVersion = (output: string, tool: string, expected: string): void => {
  const tokens = output.trim().split(/\s+/u);
  if (!output.toLocaleLowerCase("en-US").includes(tool) || !tokens.includes(expected)) {
    fail(`${tool} ${expected} is required; observed ${output.trim() || "no version output"}.`);
  }
};

const copyInstallerPayload = async (
  payload: ReadonlyArray<Awaited<ReturnType<typeof collectInstallerPayload>>[number]>,
  destinationRoot: string,
): Promise<void> => {
  for (const record of payload) {
    const destination = NodePath.join(destinationRoot, ...record.path.split("/"));
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    await NodeFSP.copyFile(record.sourcePath, destination);
    await NodeFSP.chmod(destination, Number.parseInt(record.mode, 8));
  }
};

interface NativeBuildContext {
  readonly repoRoot: string;
  readonly rust: RustToolchainRuntime;
  readonly temporary: string;
  readonly publish: string;
  readonly plan: ServerArtifactBuildPlan;
  readonly version: string;
  readonly executable: string;
  readonly stagedRoot: string;
  readonly stagedInventory: ReadonlyArray<ServerBuildFileRecord>;
  readonly macosOtherSlice?: string;
  readonly macosOtherSliceMetadata?: string;
  readonly metadata: ServerBuildMetadata;
  readonly metadataPath: string;
  readonly nativeSigning: NativeSigningState;
  readonly releaseEnv: NodeJS.ProcessEnv;
  readonly webRoot: string;
  readonly webManifestPath: string;
  readonly noticesPath: string;
  readonly readmePath: string;
  readonly commandRunner: ServerArtifactCommandRunner;
  readonly limits: ServerArtifactCommandOptions;
}

const publishMetadataFor = async (
  publish: string,
  artifactName: string,
  metadata: ServerBuildMetadata,
  artifact: Omit<PublishedServerBuildMetadata["artifact"], "downloadName">,
  fileInventory: ReadonlyArray<ServerBuildFileRecord>,
): Promise<PublishedServerArtifact> => {
  const metadataName = `${artifactName}.build.json`;
  const publishedMetadata: PublishedServerBuildMetadata = {
    ...metadata,
    artifact: { downloadName: artifactName, ...artifact },
    fileInventory,
  };
  await NodeFSP.writeFile(
    NodePath.join(publish, metadataName),
    `${JSON.stringify(publishedMetadata, null, 2)}\n`,
  );
  return { fileName: artifactName, metadataName };
};

const buildWindowsNativeInstaller = async (
  context: NativeBuildContext,
): Promise<ReadonlyArray<PublishedServerArtifact>> => {
  const descriptor = resolveNativeInstallerDescriptor(context.plan.target);
  const installerPlatform = descriptor.packageArchitectures.msi;
  if (installerPlatform === undefined) return fail("The Windows target has no MSI architecture.");
  const workspace = NodePath.join(context.temporary, "native", "windows");
  const output = NodePath.join(workspace, "output");
  const intermediate = NodePath.join(workspace, "obj");
  await NodeFSP.mkdir(output, { recursive: true });
  await NodeFSP.mkdir(intermediate, { recursive: true });
  for (const file of ["BiBCode.Server.wixproj", "Product.wxs", "variables.wxi"] as const) {
    await NodeFSP.copyFile(
      NodePath.join(context.repoRoot, "packaging", "server", "windows", file),
      NodePath.join(workspace, file),
    );
  }
  const payload = await collectInstallerPayload(context.stagedRoot, "bibcode.exe");
  await NodeFSP.writeFile(
    NodePath.join(workspace, "ServerFiles.wxs"),
    generateWixFilesFragment(context.stagedRoot, payload),
  );
  await context.commandRunner(
    {
      command: "dotnet",
      args: [
        "build",
        NodePath.join(workspace, "BiBCode.Server.wixproj"),
        "--configuration",
        "Release",
        "--nologo",
        `-p:ProductVersion=${context.version}`,
        `-p:StageRoot=${context.stagedRoot}`,
        `-p:InstallerPlatform=${installerPlatform}`,
        `-p:OutputPath=${output}${NodePath.sep}`,
        `-p:IntermediateOutputPath=${intermediate}${NodePath.sep}`,
      ],
      cwd: workspace,
    },
    context.limits,
  );
  const built = await requireExactlyOneOutput(output, ".msi", "WiX");
  const artifactName = `bibcode-server-${context.version}-windows-${descriptor.manifestArchitecture}.msi`;
  const artifactPath = NodePath.join(context.publish, artifactName);
  await NodeFSP.copyFile(built, artifactPath);
  const nativeSigning =
    context.metadata.buildMode === "signing-candidate"
      ? await signAndVerifyWindowsArtifact({
          path: artifactPath,
          cwd: workspace,
          env: context.releaseEnv,
          commandRunner: context.commandRunner,
          limits: context.limits,
        })
      : context.nativeSigning;
  return [
    await publishMetadataFor(
      context.publish,
      artifactName,
      context.metadata,
      {
        os: "windows",
        architecture: descriptor.manifestArchitecture,
        format: "msi",
        nativeSigning,
        notarized: false,
      },
      context.stagedInventory,
    ),
  ];
};

const buildLinuxNativeInstallers = async (
  context: NativeBuildContext,
): Promise<ReadonlyArray<PublishedServerArtifact>> => {
  const descriptor = resolveNativeInstallerDescriptor(context.plan.target);
  const debArchitecture = descriptor.packageArchitectures.deb;
  const rpmArchitecture = descriptor.packageArchitectures.rpm;
  if (debArchitecture === undefined || rpmArchitecture === undefined) {
    return fail("The Linux target is missing a native package architecture.");
  }
  const [debVersion, rpmVersion] = await Promise.all([
    context.commandRunner(
      {
        command: context.rust.cargo,
        args: ["deb", "--version"],
        cwd: context.repoRoot,
        env: context.rust.env,
      },
      context.limits,
    ),
    context.commandRunner(
      {
        command: context.rust.cargo,
        args: ["generate-rpm", "--version"],
        cwd: context.repoRoot,
        env: context.rust.env,
      },
      context.limits,
    ),
  ]);
  assertToolVersion(`${debVersion.stdout}\n${debVersion.stderr}`, "cargo-deb", "3.7.0");
  assertToolVersion(`${rpmVersion.stdout}\n${rpmVersion.stderr}`, "cargo-generate-rpm", "0.21.0");

  const workspace = NodePath.join(context.temporary, "native", "linux");
  await NodeFSP.mkdir(NodePath.join(workspace, "src"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(workspace, "src", "main.rs"), "fn main() {}\n");
  const renderedHooks = NodePath.join(workspace, "hooks");
  const debHooks = NodePath.join(renderedHooks, "deb");
  const rpmHooks = NodePath.join(renderedHooks, "rpm");
  await Promise.all([
    NodeFSP.mkdir(debHooks, { recursive: true }),
    NodeFSP.mkdir(rpmHooks, { recursive: true }),
  ]);
  for (const script of ["preinst", "postinst", "prerm", "postrm"] as const) {
    const template = await NodeFSP.readFile(
      NodePath.join(context.repoRoot, "packaging/server/linux/deb", script),
      "utf8",
    );
    await NodeFSP.writeFile(
      NodePath.join(debHooks, script),
      renderPackageHook(template, context.version),
      { mode: 0o755 },
    );
  }
  for (const script of [
    "pre_install",
    "post_install",
    "pre_uninstall",
    "post_uninstall",
  ] as const) {
    const template = await NodeFSP.readFile(
      NodePath.join(context.repoRoot, "packaging/server/linux/rpm", script),
      "utf8",
    );
    await NodeFSP.writeFile(
      NodePath.join(rpmHooks, script),
      renderPackageHook(template, context.version),
      { mode: 0o755 },
    );
  }
  const payload = await collectInstallerPayload(context.stagedRoot, "bibcode");
  const debManifest = renderDebCargoManifest({
    payloadRoot: context.stagedRoot,
    payload,
    version: context.version,
    maintainerScripts: debHooks,
  });
  const rpmMetadata = renderRpmMetadata({
    template: NodeFS.readFileSync(
      NodePath.join(context.repoRoot, "packaging/server/linux/rpm/metadata.toml"),
      "utf8",
    ),
    payloadRoot: context.stagedRoot,
    payload,
    scripts: {
      preInstall: NodePath.join(rpmHooks, "pre_install"),
      postInstall: NodePath.join(rpmHooks, "post_install"),
      preUninstall: NodePath.join(rpmHooks, "pre_uninstall"),
      postUninstall: NodePath.join(rpmHooks, "post_uninstall"),
    },
  });
  const manifestPath = NodePath.join(workspace, "Cargo.toml");
  await NodeFSP.writeFile(manifestPath, `${debManifest}\n${rpmMetadata}`);

  const debName = `bibcode-server-${context.version}-linux-${descriptor.manifestArchitecture}.deb`;
  const rpmName = `bibcode-server-${context.version}-linux-${descriptor.manifestArchitecture}.rpm`;
  const debPath = NodePath.join(context.publish, debName);
  const rpmPath = NodePath.join(context.publish, rpmName);
  const packageCommands = resolveLinuxNativePackageCommands({
    manifestPath,
    target: context.plan.target,
    debOutputPath: debPath,
    rpmOutputPath: rpmPath,
    rpmArchitecture,
  });
  await context.commandRunner(
    {
      command: context.rust.cargo,
      args: packageCommands.debArgs,
      cwd: workspace,
      env: context.rust.env,
    },
    context.limits,
  );
  await context.commandRunner(
    {
      command: context.rust.cargo,
      args: packageCommands.rpmArgs,
      cwd: workspace,
      env: context.rust.env,
    },
    context.limits,
  );
  assertPlainFile(debPath, `DEB ${debArchitecture} installer`);
  assertPlainFile(rpmPath, `RPM ${rpmArchitecture} installer`);
  return Promise.all([
    publishMetadataFor(
      context.publish,
      debName,
      context.metadata,
      {
        os: "linux",
        architecture: descriptor.manifestArchitecture,
        format: "deb",
        nativeSigning: unsignedNativeSigning(),
        notarized: false,
      },
      context.stagedInventory,
    ),
    publishMetadataFor(
      context.publish,
      rpmName,
      context.metadata,
      {
        os: "linux",
        architecture: descriptor.manifestArchitecture,
        format: "rpm",
        nativeSigning: unsignedNativeSigning(),
        notarized: false,
      },
      context.stagedInventory,
    ),
  ]);
};

const buildMacNativeInstaller = async (
  context: NativeBuildContext,
): Promise<ReadonlyArray<PublishedServerArtifact>> => {
  const otherTarget: ServerTargetTriple =
    context.plan.target === "aarch64-apple-darwin" ? "x86_64-apple-darwin" : "aarch64-apple-darwin";
  let otherExecutable: string;
  if (context.macosOtherSlice !== undefined && context.macosOtherSliceMetadata !== undefined) {
    otherExecutable = context.macosOtherSlice;
    const otherMetadata = readJson<Partial<ServerBuildMetadata>>(context.macosOtherSliceMetadata);
    if (
      otherMetadata.schemaVersion !== 1 ||
      otherMetadata.product !== "bibcode-server" ||
      otherMetadata.version !== context.version ||
      otherMetadata.sourceSha !== context.metadata.sourceSha ||
      otherMetadata.targetTriple !== otherTarget ||
      otherMetadata.binarySha256 !== (await sha256File(otherExecutable))
    ) {
      return fail("The externally built macOS slice does not match the release identity.");
    }
  } else {
    const otherBuild = await context.commandRunner(
      {
        command: context.rust.cargo,
        args: cargoArgsForTarget(otherTarget),
        cwd: context.repoRoot,
        env: context.rust.env,
      },
      context.limits,
    );
    otherExecutable = parseCargoServerExecutable(otherBuild.stdout, {
      cargoTargetDirectory: NodePath.join(context.repoRoot, "target", otherTarget, "release"),
      executableName: "bibcode",
    });
  }
  assertPlainFile(otherExecutable, `Cargo ${otherTarget} server executable`);
  const otherArchitectures = await context.commandRunner(
    { command: "lipo", args: ["-archs", otherExecutable], cwd: context.repoRoot },
    context.limits,
  );
  const expectedOtherArchitecture = otherTarget === "x86_64-apple-darwin" ? "x86_64" : "arm64";
  if (otherArchitectures.stdout.trim() !== expectedOtherArchitecture) {
    return fail(`The ${otherTarget} external server slice has the wrong Mach-O architecture.`);
  }
  const otherVersion = await context.commandRunner(
    { command: otherExecutable, args: ["--version"], cwd: context.repoRoot },
    context.limits,
  );
  if (!otherVersion.stdout.split(/\s+/u).includes(context.version)) {
    return fail(`The ${otherTarget} server executable does not report version ${context.version}.`);
  }

  const workspace = NodePath.join(context.temporary, "native", "macos");
  await NodeFSP.mkdir(workspace, { recursive: true });
  const developerConfiguration =
    context.metadata.buildMode === "signing-candidate"
      ? resolveMacDeveloperIdConfiguration(context.releaseEnv)
      : null;
  const otherPreparedDirectory = NodePath.join(workspace, "prepared", otherTarget);
  await NodeFSP.mkdir(otherPreparedDirectory, { recursive: true });
  const otherPreparedExecutable = NodePath.join(otherPreparedDirectory, "bibcode");
  await NodeFSP.copyFile(otherExecutable, otherPreparedExecutable);
  await NodeFSP.chmod(otherPreparedExecutable, 0o755);
  await signAndVerifyMacExecutable({
    path: otherPreparedExecutable,
    cwd: workspace,
    configuration: developerConfiguration,
    commandRunner: context.commandRunner,
    limits: context.limits,
  });
  const universalExecutable = NodePath.join(workspace, "bibcode");
  const binaries = new Map<ServerTargetTriple, string>([
    [context.plan.target, context.executable],
    [otherTarget, otherPreparedExecutable],
  ]);
  await context.commandRunner(
    {
      command: "lipo",
      args: [
        "-create",
        binaries.get("x86_64-apple-darwin") ?? fail("The x86_64 macOS slice is missing."),
        binaries.get("aarch64-apple-darwin") ?? fail("The arm64 macOS slice is missing."),
        "-output",
        universalExecutable,
      ],
      cwd: workspace,
    },
    context.limits,
  );
  await NodeFSP.chmod(universalExecutable, 0o755);
  const archs = await context.commandRunner(
    { command: "lipo", args: ["-archs", universalExecutable], cwd: workspace },
    context.limits,
  );
  const observedArchs = new Set(archs.stdout.trim().split(/\s+/u).filter(Boolean));
  if (observedArchs.size !== 2 || !observedArchs.has("x86_64") || !observedArchs.has("arm64")) {
    return fail(`The universal macOS executable has invalid slices: ${archs.stdout.trim()}.`);
  }
  const universalSigning = await signAndVerifyMacExecutable({
    path: universalExecutable,
    cwd: workspace,
    configuration: developerConfiguration,
    commandRunner: context.commandRunner,
    limits: context.limits,
  });

  const universalMetadata: ServerBuildMetadata = {
    ...context.metadata,
    targetTriple: "universal-apple-darwin",
    binarySha256: await sha256File(universalExecutable),
    sliceSha256: {
      "x86_64-apple-darwin": await sha256File(
        binaries.get("x86_64-apple-darwin") ?? fail("The x86_64 slice hash input is missing."),
      ),
      "aarch64-apple-darwin": await sha256File(
        binaries.get("aarch64-apple-darwin") ?? fail("The arm64 slice hash input is missing."),
      ),
    },
  };
  const universalMetadataPath = NodePath.join(workspace, "build-metadata.json");
  await writeBuildMetadata(universalMetadataPath, universalMetadata);
  const universalStage = NodePath.join(workspace, "stage", "bibcode-server");
  await stageServerLayout(
    {
      repoRoot: context.repoRoot,
      rust: context.rust,
      executable: universalExecutable,
      webRoot: context.webRoot,
      webManifestPath: context.webManifestPath,
      noticesPath: context.noticesPath,
      readmePath: context.readmePath,
      metadataPath: universalMetadataPath,
      output: universalStage,
    },
    context.commandRunner,
    context.limits,
  );

  const packageRoot = NodePath.join(workspace, "root");
  const installRoot = NodePath.join(packageRoot, "usr/local/libexec/bibcode-server");
  const payload = await collectInstallerPayload(universalStage, "bibcode");
  await copyInstallerPayload(payload, installRoot);
  const linkDirectory = NodePath.join(packageRoot, "usr/local/bin");
  await NodeFSP.mkdir(linkDirectory, { recursive: true });
  await NodeFSP.symlink(
    "../libexec/bibcode-server/bin/bibcode",
    NodePath.join(linkDirectory, "bibcode"),
  );
  await context.commandRunner(
    { command: "xattr", args: ["-cr", packageRoot], cwd: workspace },
    context.limits,
  );

  const scripts = NodePath.join(workspace, "scripts");
  await NodeFSP.mkdir(scripts, { recursive: true });
  for (const script of ["preinstall", "postinstall"] as const) {
    const source = NodePath.join(context.repoRoot, "packaging/server/macos/scripts", script);
    if (!isPlainExecutable(source))
      return fail(`macOS package script must be executable: ${source}.`);
    const template = await NodeFSP.readFile(source, "utf8");
    const path = NodePath.join(scripts, script);
    await NodeFSP.writeFile(path, renderPackageHook(template, context.version), {
      mode: 0o755,
    });
  }
  const componentPath = NodePath.join(workspace, "BiBCodeServer-component.pkg");
  const packageEnv = { ...context.rust.env, COPYFILE_DISABLE: "1" };
  await context.commandRunner(
    {
      command: "pkgbuild",
      args: [
        "--root",
        packageRoot,
        "--identifier",
        "com.bibcode.server",
        "--version",
        context.version,
        "--install-location",
        "/",
        "--scripts",
        scripts,
        "--ownership",
        "recommended",
        componentPath,
      ],
      cwd: workspace,
      env: packageEnv,
    },
    context.limits,
  );
  const distributionPath = NodePath.join(workspace, "Distribution.xml");
  await NodeFSP.writeFile(
    distributionPath,
    renderMacDistribution(
      NodeFS.readFileSync(
        NodePath.join(context.repoRoot, "packaging/server/macos/Distribution.xml"),
        "utf8",
      ),
      context.version,
    ),
  );
  const artifactName = `bibcode-server-${context.version}-macos-universal.pkg`;
  const artifactPath = NodePath.join(context.publish, artifactName);
  const unsignedArtifactPath =
    developerConfiguration === null
      ? artifactPath
      : NodePath.join(workspace, "BiBCodeServer-unsigned.pkg");
  await context.commandRunner(
    {
      command: "productbuild",
      args: ["--distribution", distributionPath, "--package-path", workspace, unsignedArtifactPath],
      cwd: workspace,
      env: packageEnv,
    },
    context.limits,
  );
  if (developerConfiguration !== null) {
    const runSensitive = async (
      plan: ServerArtifactCommandPlan,
      failure: string,
    ): Promise<void> => {
      try {
        await context.commandRunner(plan, context.limits);
      } catch {
        fail(failure);
      }
    };
    await runSensitive(
      {
        command: "productsign",
        args: [
          "--sign",
          developerConfiguration.installerIdentity,
          unsignedArtifactPath,
          artifactPath,
        ],
        cwd: workspace,
      },
      "macOS Developer ID package signing failed.",
    );
    await runSensitive(
      { command: "pkgutil", args: ["--check-signature", artifactPath], cwd: workspace },
      "macOS Developer ID package signature verification failed.",
    );
    await runSensitive(
      {
        command: "xcrun",
        args: [
          "notarytool",
          "submit",
          artifactPath,
          "--keychain-profile",
          developerConfiguration.notaryProfile,
          "--wait",
        ],
        cwd: workspace,
      },
      "macOS package notarization failed.",
    );
    await runSensitive(
      { command: "xcrun", args: ["stapler", "staple", artifactPath], cwd: workspace },
      "macOS package notarization staple failed.",
    );
    await runSensitive(
      { command: "xcrun", args: ["stapler", "validate", artifactPath], cwd: workspace },
      "macOS package notarization staple verification failed.",
    );
    await runSensitive(
      {
        command: "spctl",
        args: ["--assess", "--type", "install", "--verbose=4", artifactPath],
        cwd: workspace,
      },
      "macOS Developer ID package assessment failed.",
    );
  }
  assertPlainFile(artifactPath, "macOS universal product package");
  const payloadListing = await context.commandRunner(
    { command: "pkgutil", args: ["--payload-files", artifactPath], cwd: workspace },
    context.limits,
  );
  validateMacPackagePayloadListing(payloadListing.stdout);
  return [
    await publishMetadataFor(
      context.publish,
      artifactName,
      universalMetadata,
      {
        os: "macos",
        architecture: "universal",
        format: "pkg",
        nativeSigning:
          developerConfiguration === null
            ? universalSigning
            : { ...universalSigning, package: "developer-id" },
        notarized: developerConfiguration !== null,
      },
      await fileInventoryForPayload(universalStage, "bibcode"),
    ),
  ];
};

const buildNativeInstallers = async (
  context: NativeBuildContext,
): Promise<ReadonlyArray<PublishedServerArtifact>> => {
  switch (SERVER_PORTABLE_TARGETS[context.plan.target].platform) {
    case "win32":
      return buildWindowsNativeInstaller(context);
    case "darwin":
      return buildMacNativeInstaller(context);
    case "linux":
      return buildLinuxNativeInstallers(context);
  }
};

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
  const requiredInputRelatives = [
    "Cargo.lock",
    "pnpm-lock.yaml",
    "rust-toolchain.toml",
    "LICENSE",
    "apps/web/package.json",
    "apps/server/package.json",
    "apps/server/Cargo.toml",
    "packaging/server/common/install-layout.json",
  ];
  if (plan.formats.includes("native")) {
    switch (SERVER_PORTABLE_TARGETS[plan.target].platform) {
      case "win32":
        requiredInputRelatives.push(
          "packaging/server/windows/BiBCode.Server.wixproj",
          "packaging/server/windows/Product.wxs",
          "packaging/server/windows/variables.wxi",
        );
        break;
      case "darwin":
        requiredInputRelatives.push(
          "packaging/server/macos/Distribution.xml",
          "packaging/server/macos/scripts/preinstall",
          "packaging/server/macos/scripts/postinstall",
        );
        break;
      case "linux":
        requiredInputRelatives.push(
          "packaging/server/linux/deb/postinst",
          "packaging/server/linux/deb/preinst",
          "packaging/server/linux/deb/prerm",
          "packaging/server/linux/deb/postrm",
          "packaging/server/linux/rpm/metadata.toml",
          "packaging/server/linux/rpm/post_install",
          "packaging/server/linux/rpm/pre_install",
          "packaging/server/linux/rpm/pre_uninstall",
          "packaging/server/linux/rpm/post_uninstall",
        );
        break;
    }
  }
  const requiredInputs = requiredInputRelatives.map((relative) =>
    NodePath.join(repoRoot, relative),
  );
  for (const path of requiredInputs) assertPlainFile(path, "Required frozen build input");
  const rustToolchain = parsePinnedRustToolchainChannel(
    NodeFS.readFileSync(NodePath.join(repoRoot, "rust-toolchain.toml"), "utf8"),
  );
  if (Boolean(input.webAssetsDir) !== Boolean(input.webAssetsManifest)) {
    return fail("--web-assets-dir and --web-assets-manifest must be provided together.");
  }
  if (Boolean(input.macosOtherSlice) !== Boolean(input.macosOtherSliceMetadata)) {
    return fail("--macos-other-slice and --macos-other-slice-metadata must be provided together.");
  }
  if (
    input.macosOtherSlice !== undefined &&
    (SERVER_PORTABLE_TARGETS[plan.target].platform !== "darwin" || !plan.formats.includes("native"))
  ) {
    return fail("An external macOS slice is valid only for a native macOS package build.");
  }
  const macosOtherSlice =
    input.macosOtherSlice === undefined
      ? undefined
      : NodePath.resolve(repoRoot, input.macosOtherSlice);
  const macosOtherSliceMetadata =
    input.macosOtherSliceMetadata === undefined
      ? undefined
      : NodePath.resolve(repoRoot, input.macosOtherSliceMetadata);
  if (macosOtherSlice !== undefined && macosOtherSliceMetadata !== undefined) {
    assertPlainFile(macosOtherSlice, "External macOS server slice");
    assertPlainFile(macosOtherSliceMetadata, "External macOS server slice metadata");
  }

  const commandRunner: ServerArtifactCommandRunner =
    options.commandRunner ?? ((command, limits) => runBoundedCommand(command, limits));
  const limits: ServerArtifactCommandOptions = {
    timeoutMs: plan.timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const rust = await resolveRustToolchainRuntime(
    rustToolchain,
    env,
    repoRoot,
    commandRunner,
    limits,
  );
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
          command: rust.cargo,
          args: ["metadata", "--locked", "--format-version", "1", "--filter-platform", plan.target],
          cwd: repoRoot,
          env: rust.env,
        },
        limits,
      ),
      commandRunner(
        {
          command: rust.rustc,
          args: ["--version", "--verbose"],
          cwd: repoRoot,
          env: rust.env,
        },
        limits,
      ),
    ]);
    const notices = generateThirdPartyNoticesMarkdown([
      ...parseCargoNoticePackages(cargoMetadata.stdout),
      ...collectInstalledPnpmNoticePackages(NodePath.join(repoRoot, "apps/web/package.json")),
    ]);
    const noticesPath = NodePath.join(temporary, "THIRD-PARTY-NOTICES.md");
    await NodeFSP.writeFile(noticesPath, notices);

    const cargoBuild = await commandRunner(
      {
        command: rust.cargo,
        args: plan.cargoArgs,
        cwd: repoRoot,
        env: rust.env,
      },
      limits,
    );
    const cargoExecutable = parseCargoServerExecutable(cargoBuild.stdout, plan);
    assertPlainFile(cargoExecutable, "Cargo server executable");
    const preparedDirectory = NodePath.join(temporary, "prepared-binary");
    await NodeFSP.mkdir(preparedDirectory);
    const executable = NodePath.join(preparedDirectory, plan.executableName);
    await NodeFSP.copyFile(cargoExecutable, executable);
    if (SERVER_PORTABLE_TARGETS[plan.target].platform !== "win32") {
      await NodeFSP.chmod(executable, 0o755);
    }
    let nativeSigning = unsignedNativeSigning();
    if (SERVER_PORTABLE_TARGETS[plan.target].platform === "win32" && input.unsignedTest !== true) {
      nativeSigning = await signAndVerifyWindowsArtifact({
        path: executable,
        cwd: repoRoot,
        env,
        commandRunner,
        limits,
      });
    } else if (SERVER_PORTABLE_TARGETS[plan.target].platform === "darwin") {
      nativeSigning = await signAndVerifyMacExecutable({
        path: executable,
        cwd: repoRoot,
        configuration: input.unsignedTest === true ? null : resolveMacDeveloperIdConfiguration(env),
        commandRunner,
        limits,
      });
    }
    const versionOutput = await commandRunner(
      { command: executable, args: ["--version"], cwd: repoRoot },
      limits,
    );
    if (!versionOutput.stdout.split(/\s+/u).includes(version)) {
      return fail(`The built server executable does not report version ${version}.`);
    }
    const binarySha256 = await sha256File(executable);
    const metadata: ServerBuildMetadata = {
      schemaVersion: 1,
      product: "bibcode-server",
      buildMode: input.unsignedTest === true ? "unsigned-test" : "signing-candidate",
      version,
      sourceSha,
      targetTriple: plan.target,
      sourceDateEpoch,
      rustc: rustc.stdout.trim(),
      binarySha256,
    };
    const metadataPath = NodePath.join(temporary, "build-metadata.json");
    await writeBuildMetadata(metadataPath, metadata);
    const readmePath = NodePath.join(temporary, "README.md");
    await NodeFSP.writeFile(readmePath, portableReadme(version));

    const stagedRoot = NodePath.join(temporary, "stage", "bibcode-server");
    const requiresCurrentTargetStage =
      plan.formats.includes("portable") ||
      (plan.formats.includes("native") &&
        SERVER_PORTABLE_TARGETS[plan.target].platform !== "darwin");
    if (requiresCurrentTargetStage) {
      await stageServerLayout(
        {
          repoRoot,
          rust,
          executable,
          webRoot,
          webManifestPath,
          noticesPath,
          readmePath,
          metadataPath,
          output: stagedRoot,
        },
        commandRunner,
        limits,
      );
    }
    const stagedInventory = requiresCurrentTargetStage
      ? await fileInventoryForPayload(stagedRoot, plan.executableName)
      : [];

    const publish = NodePath.join(temporary, "publish");
    await NodeFSP.mkdir(publish);
    const published: PublishedServerArtifact[] = [];
    let archiveName: string | undefined;
    if (plan.formats.includes("portable")) {
      const suffix = plan.portableFormat;
      archiveName = `bibcode-server-${version}-${plan.target}.${suffix}`;
      const archivePath = NodePath.join(publish, archiveName);
      await commandRunner(
        {
          command: rust.cargo,
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
          env: rust.env,
        },
        limits,
      );
      assertPlainFile(archivePath, "Portable server archive");
      published.push(
        await publishMetadataFor(
          publish,
          archiveName,
          metadata,
          {
            os: artifactOsForTarget(plan.target),
            architecture: artifactArchitectureForTarget(plan.target),
            format: plan.portableFormat,
            nativeSigning,
            notarized: false,
          },
          stagedInventory,
        ),
      );
    }

    if (plan.formats.includes("native")) {
      published.push(
        ...(await buildNativeInstallers({
          repoRoot,
          rust,
          temporary,
          publish,
          plan,
          version,
          executable,
          stagedRoot,
          stagedInventory,
          ...(macosOtherSlice ? { macosOtherSlice } : {}),
          ...(macosOtherSliceMetadata ? { macosOtherSliceMetadata } : {}),
          metadata,
          metadataPath,
          nativeSigning,
          releaseEnv: env,
          webRoot,
          webManifestPath,
          noticesPath,
          readmePath,
          commandRunner,
          limits,
        })),
      );
    }
    if (published.length === 0) return fail("The server build produced no requested artifacts.");
    for (const artifact of published) {
      assertPlainFile(NodePath.join(publish, artifact.fileName), "Published server artifact");
      assertPlainFile(NodePath.join(publish, artifact.metadataName), "Published build metadata");
    }
    await NodeFSP.rename(publish, plan.outputDir);
    const artifactPaths = published.map((artifact) =>
      NodePath.join(plan.outputDir, artifact.fileName),
    );
    const metadataPaths = published.map((artifact) =>
      NodePath.join(plan.outputDir, artifact.metadataName),
    );
    const archiveIndex = archiveName
      ? published.findIndex((artifact) => artifact.fileName === archiveName)
      : -1;
    return {
      artifactPaths,
      metadataPaths,
      ...(archiveIndex >= 0
        ? {
            archivePath: artifactPaths[archiveIndex],
            metadataPath: metadataPaths[archiveIndex],
          }
        : {}),
    };
  } finally {
    await NodeFSP.rm(temporary, { recursive: true, force: true });
  }
}

export async function runBuildServerArtifactMain(
  argv: ReadonlyArray<string> = process.argv.slice(2),
): Promise<void> {
  const result = await buildServerArtifact(parseServerArtifactCliArgs(argv));
  process.stdout.write(`${[...result.artifactPaths, ...result.metadataPaths].join("\n")}\n`);
}

const invokedPath = process.argv[1] ? NodePath.resolve(process.argv[1]) : undefined;
if (invokedPath && NodeURL.pathToFileURL(invokedPath).href === import.meta.url) {
  runBuildServerArtifactMain().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Server build failed."}\n`);
    process.exitCode = 1;
  });
}
