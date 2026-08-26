#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off - Standalone native smoke stages own bounded host-process timeouts.
// @effect-diagnostics globalDate:off - Evidence timestamps are wall-clock execution-report metadata.

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import type {
  ServerArtifactArchitecture,
  ServerArtifactFormat,
  ServerArtifactManifest,
  ServerArtifactOs,
  ServerArtifactRecord,
} from "@bibcode/contracts";

import { verifyServerArtifacts } from "./verify-server-artifacts.ts";
import { createNativeServerInstallSmokeDriver } from "./lib/server-install-smoke-driver.ts";

export const SERVER_INSTALL_SMOKE_SCENARIOS = [
  "clean-workstation-install",
  "single-loopback-service",
  "single-use-dpop-pairing",
  "same-origin-ui-without-node",
  "restart-preserves-identities",
  "upgrade-preserves-data-and-backup",
  "failed-upgrade-recovers-safely",
  "uninstall-preserves-data",
  "reinstall-adopts-identities",
  "typed-purge-removes-exact-root",
  "headless-account-and-acl",
  "owned-process-and-temporary-cleanup",
] as const;

export type ServerInstallSmokeScenario = (typeof SERVER_INSTALL_SMOKE_SCENARIOS)[number];
export type ServerInstallSmokeStatus = "passed" | "failed" | "unavailable";
export type ServerInstallSmokeClassification = "native" | "compatibility" | "unavailable";

export interface ServerInstallSmokeScenarioResult {
  readonly scenario: ServerInstallSmokeScenario;
  readonly status: ServerInstallSmokeStatus;
  readonly classification: ServerInstallSmokeClassification;
  readonly code: string;
}

export interface ServerInstallSmokeInput {
  readonly manifestPath: string;
  readonly artifactRoot: string;
  readonly os: ServerArtifactOs;
  readonly architecture: ServerArtifactArchitecture;
  readonly format: ServerArtifactFormat;
  readonly workRoot: string;
  readonly stageTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly allowUnsignedTest?: boolean;
  readonly publicKeyPath?: string;
  readonly allowSystemMutation?: boolean;
}

export interface ServerInstallSmokeContext {
  readonly artifact: ServerArtifactRecord;
  readonly artifactPath: string;
  readonly manifest: ServerArtifactManifest;
  readonly workRoot: string;
  readonly stageTimeoutMs: number;
  readonly commandTimeoutMs: number;
  readonly allowSystemMutation: boolean;
  readonly abortSignal: AbortSignal;
}

export interface ServerInstallSmokeDriver {
  readonly execute: (
    context: ServerInstallSmokeContext,
  ) => Promise<ReadonlyArray<ServerInstallSmokeScenarioResult>>;
  readonly cleanup: (context: ServerInstallSmokeContext) => Promise<void>;
}

export interface ServerInstallSmokeEvidence {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly sourceSha: string;
  readonly manifestSha256: string;
  readonly artifact: Pick<
    ServerArtifactRecord,
    | "downloadName"
    | "targetTriple"
    | "os"
    | "architecture"
    | "format"
    | "size"
    | "sha256"
    | "nativeSigning"
    | "notarized"
  >;
  readonly scenarios: ReadonlyArray<ServerInstallSmokeScenarioResult>;
}

interface ServerInstallSmokeDependencies {
  readonly driver?: ServerInstallSmokeDriver;
  readonly now?: () => Date;
  readonly verify?: typeof verifyServerArtifacts;
}

const DEFAULT_STAGE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 2 * 60_000;
const SAFE_EVIDENCE_CODE = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

const fail = (message: string): never => {
  throw new Error(message);
};

const sha256File = async (path: string): Promise<string> => {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

const requireBoundedTimeout = (value: number | undefined, fallback: number): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1_000 || resolved > 30 * 60_000) {
    return fail("Server install smoke timeouts must be between one second and thirty minutes.");
  }
  return resolved;
};

const requireAbsolute = (path: string, label: string): string => {
  if (!NodePath.isAbsolute(path)) return fail(`${label} must be absolute.`);
  return NodePath.resolve(path);
};

const requirePlainDirectory = (path: string, label: string): string => {
  const metadata = NodeFS.lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    return fail(`${label} must be a plain directory.`);
  }
  return NodeFS.realpathSync(path);
};

const resolveFreshWorkRoot = (
  path: string,
): { readonly canonical: string; readonly exists: boolean } => {
  const absolute = requireAbsolute(path, "The server install smoke work root");
  if (NodeFS.existsSync(absolute)) {
    const canonical = requirePlainDirectory(absolute, "The server install smoke work root");
    return { canonical, exists: true };
  }
  const parent = requirePlainDirectory(
    NodePath.dirname(absolute),
    "The server install smoke work-root parent",
  );
  return { canonical: NodePath.join(parent, NodePath.basename(absolute)), exists: false };
};

const overlaps = (left: string, right: string): boolean => {
  if (left === right) return true;
  const relative = NodePath.relative(left, right);
  return relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
};

const withTimeout = async <T>(
  start: (abortSignal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  settleTimeoutMs: number,
): Promise<T> => {
  const controller = new AbortController();
  const operation = start(controller.signal);
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error("The bounded server install smoke stage timed out."));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (timedOut) {
      await Promise.race([
        operation.then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => setTimeout(resolve, settleTimeoutMs)),
      ]);
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const validateScenarioResults = (
  results: ReadonlyArray<ServerInstallSmokeScenarioResult>,
): ReadonlyArray<ServerInstallSmokeScenarioResult> => {
  const byScenario = new Map<ServerInstallSmokeScenario, ServerInstallSmokeScenarioResult>();
  for (const result of results) {
    if (!SERVER_INSTALL_SMOKE_SCENARIOS.includes(result.scenario)) {
      return fail("The native smoke driver returned an unknown scenario.");
    }
    if (byScenario.has(result.scenario)) {
      return fail("The native smoke driver must return exactly one result per scenario.");
    }
    if (!SAFE_EVIDENCE_CODE.test(result.code)) {
      return fail("The native smoke driver returned an unsafe evidence code.");
    }
    if (
      (result.status === "unavailable") !== (result.classification === "unavailable") ||
      (result.status === "passed" && result.classification === "unavailable")
    ) {
      return fail("The native smoke driver returned inconsistent evidence classification.");
    }
    byScenario.set(result.scenario, result);
  }
  if (byScenario.size !== SERVER_INSTALL_SMOKE_SCENARIOS.length) {
    return fail("The native smoke driver must return exactly one result per scenario.");
  }
  return SERVER_INSTALL_SMOKE_SCENARIOS.map(
    (scenario) => byScenario.get(scenario) ?? fail("Native smoke scenario evidence disappeared."),
  );
};

const writeEvidence = async (
  workRoot: string,
  evidence: ServerInstallSmokeEvidence,
): Promise<void> => {
  const temporary = NodePath.join(workRoot, ".evidence.json.tmp");
  const destination = NodePath.join(workRoot, "evidence.json");
  await NodeFSP.writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await NodeFSP.rename(temporary, destination);
};

export async function runServerInstallSmoke(
  input: ServerInstallSmokeInput,
  dependencies: ServerInstallSmokeDependencies = {},
): Promise<ServerInstallSmokeEvidence> {
  const manifestPath = requireAbsolute(input.manifestPath, "The server artifact manifest path");
  const canonicalManifestPath = NodeFS.realpathSync(manifestPath);
  const artifactRoot = requirePlainDirectory(
    requireAbsolute(input.artifactRoot, "The server artifact root"),
    "The server artifact root",
  );
  if (canonicalManifestPath !== NodePath.join(artifactRoot, NodePath.basename(manifestPath))) {
    return fail("The server artifact manifest must be a direct file in the artifact root.");
  }
  const work = resolveFreshWorkRoot(input.workRoot);
  if (overlaps(artifactRoot, work.canonical) || overlaps(work.canonical, artifactRoot)) {
    return fail("The server artifact and work roots must be distinct and non-nested.");
  }
  if (work.exists && NodeFS.readdirSync(work.canonical).length > 0) {
    return fail("The server install smoke work root must be empty.");
  }
  const stageTimeoutMs = requireBoundedTimeout(input.stageTimeoutMs, DEFAULT_STAGE_TIMEOUT_MS);
  const commandTimeoutMs = requireBoundedTimeout(
    input.commandTimeoutMs,
    DEFAULT_COMMAND_TIMEOUT_MS,
  );
  const verify = dependencies.verify ?? verifyServerArtifacts;
  const manifest = await verify({
    manifestPath: canonicalManifestPath,
    directory: artifactRoot,
    ...(input.allowUnsignedTest === undefined
      ? {}
      : { allowUnsignedTest: input.allowUnsignedTest }),
    ...(input.publicKeyPath === undefined ? {} : { publicKeyPath: input.publicKeyPath }),
  });
  const matches = manifest.artifacts.filter(
    (artifact) =>
      artifact.os === input.os &&
      artifact.architecture === input.architecture &&
      artifact.format === input.format,
  );
  if (matches.length !== 1) {
    return fail("The server artifact manifest must select exactly one requested native tuple.");
  }
  const artifact = matches[0] ?? fail("The selected native artifact disappeared.");
  const artifactPath = NodePath.join(artifactRoot, artifact.downloadName);
  if (!work.exists) await NodeFSP.mkdir(work.canonical, { mode: 0o700 });

  const driver = dependencies.driver ?? createNativeServerInstallSmokeDriver();
  const context: ServerInstallSmokeContext = {
    artifact,
    artifactPath,
    manifest,
    workRoot: work.canonical,
    stageTimeoutMs,
    commandTimeoutMs,
    allowSystemMutation: input.allowSystemMutation === true,
    abortSignal: new AbortController().signal,
  };
  let rawResults: ReadonlyArray<ServerInstallSmokeScenarioResult>;
  let executionError: unknown;
  try {
    rawResults = await withTimeout(
      (abortSignal) => driver.execute({ ...context, abortSignal }),
      stageTimeoutMs,
      commandTimeoutMs,
    );
  } catch (error) {
    executionError = error;
    rawResults = [];
  }
  let cleanupError: unknown;
  try {
    await withTimeout(
      (abortSignal) => driver.cleanup({ ...context, abortSignal }),
      commandTimeoutMs,
      commandTimeoutMs,
    );
  } catch (error) {
    cleanupError = error;
  }
  if (executionError !== undefined) {
    throw new Error("The native server install smoke driver failed; cleanup was attempted.");
  }
  const scenarios = [...validateScenarioResults(rawResults)];
  if (cleanupError !== undefined) {
    const cleanupIndex = scenarios.findIndex(
      ({ scenario }) => scenario === "owned-process-and-temporary-cleanup",
    );
    scenarios[cleanupIndex] = {
      scenario: "owned-process-and-temporary-cleanup",
      status: "failed",
      classification: "native",
      code: "cleanup-failed",
    };
  }
  const evidence: ServerInstallSmokeEvidence = {
    schemaVersion: 1,
    generatedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    sourceSha: manifest.sourceSha,
    manifestSha256: await sha256File(canonicalManifestPath),
    artifact: {
      downloadName: artifact.downloadName,
      targetTriple: artifact.targetTriple,
      os: artifact.os,
      architecture: artifact.architecture,
      format: artifact.format,
      size: artifact.size,
      sha256: artifact.sha256,
      nativeSigning: artifact.nativeSigning,
      notarized: artifact.notarized,
    },
    scenarios,
  };
  await writeEvidence(work.canonical, evidence);
  if (cleanupError !== undefined || scenarios.some(({ status }) => status === "failed")) {
    return fail("The native server install smoke evidence contains a failed scenario.");
  }
  return evidence;
}

const parsePositiveInteger = (value: string | undefined, name: string): number => {
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) {
    return fail(`Invalid ${name}.`);
  }
  return Number(value);
};

export function parseServerInstallSmokeCliArgs(
  argv: ReadonlyArray<string>,
): ServerInstallSmokeInput {
  const values = new Map<string, string>();
  let allowUnsignedTest = false;
  let allowSystemMutation = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-unsigned-test") {
      allowUnsignedTest = true;
      continue;
    }
    if (argument === "--allow-system-mutation") {
      allowSystemMutation = true;
      continue;
    }
    const value = argv[index + 1];
    if (!argument?.startsWith("--") || value === undefined || value.startsWith("--")) {
      return fail(
        "Usage: server-install-smoke --manifest <absolute> --artifact-root <absolute> --os <os> --architecture <arch> --format <format> --work-root <absolute> [--stage-timeout-ms <ms>] [--command-timeout-ms <ms>] [--public-key <path>] [--allow-unsigned-test] [--allow-system-mutation]",
      );
    }
    if (values.has(argument)) return fail(`Duplicate server install smoke argument: ${argument}`);
    values.set(argument, value);
    index += 1;
  }
  const required = [
    "--manifest",
    "--artifact-root",
    "--os",
    "--architecture",
    "--format",
    "--work-root",
  ] as const;
  const allowed = new Set([
    ...required,
    "--stage-timeout-ms",
    "--command-timeout-ms",
    "--public-key",
  ]);
  if (
    required.some((name) => !values.has(name)) ||
    [...values.keys()].some((key) => !allowed.has(key))
  ) {
    return fail(
      "Usage: server-install-smoke --manifest <absolute> --artifact-root <absolute> --os <os> --architecture <arch> --format <format> --work-root <absolute> [--stage-timeout-ms <ms>] [--command-timeout-ms <ms>] [--public-key <path>] [--allow-unsigned-test] [--allow-system-mutation]",
    );
  }
  const os = values.get("--os");
  const architecture = values.get("--architecture");
  const format = values.get("--format");
  if (!(["linux", "macos", "windows"] as const).includes(os as ServerArtifactOs)) {
    return fail("Invalid server install smoke OS.");
  }
  if (
    !(["x86_64", "aarch64", "universal"] as const).includes(
      architecture as ServerArtifactArchitecture,
    )
  ) {
    return fail("Invalid server install smoke architecture.");
  }
  if (
    !(["zip", "tar.gz", "msi", "pkg", "deb", "rpm"] as const).includes(
      format as ServerArtifactFormat,
    )
  ) {
    return fail("Invalid server install smoke format.");
  }
  const stageTimeout = values.get("--stage-timeout-ms");
  const commandTimeout = values.get("--command-timeout-ms");
  const publicKeyPath = values.get("--public-key");
  return {
    manifestPath: values.get("--manifest") ?? "",
    artifactRoot: values.get("--artifact-root") ?? "",
    os: os as ServerArtifactOs,
    architecture: architecture as ServerArtifactArchitecture,
    format: format as ServerArtifactFormat,
    workRoot: values.get("--work-root") ?? "",
    ...(stageTimeout === undefined
      ? {}
      : { stageTimeoutMs: parsePositiveInteger(stageTimeout, "stage timeout") }),
    ...(commandTimeout === undefined
      ? {}
      : { commandTimeoutMs: parsePositiveInteger(commandTimeout, "command timeout") }),
    ...(publicKeyPath === undefined ? {} : { publicKeyPath }),
    allowUnsignedTest,
    ...(allowSystemMutation ? { allowSystemMutation: true } : {}),
  };
}

const invokedPath = process.argv[1] ? NodePath.resolve(process.argv[1]) : undefined;
const modulePath = NodePath.resolve(NodeURL.fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  runServerInstallSmoke(parseServerInstallSmokeCliArgs(process.argv.slice(2)))
    .then((evidence) => process.stdout.write(`${JSON.stringify(evidence)}\n`))
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "Server install smoke failed."}\n`,
      );
      process.exitCode = 1;
    });
}
