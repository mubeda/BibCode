#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This release harness owns host processes and paths.
// @effect-diagnostics globalConsole:off - The standalone harness reports bounded progress.
// @effect-diagnostics globalFetch:off - The standalone harness probes its loopback update server.
// @effect-diagnostics globalTimers:off - The standalone harness owns bounded process timeouts.
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import { parse as parseToml, type TomlTable } from "smol-toml";
import {
  REMOTE_UPDATE_DOWNLOAD_BUDGET_MS,
  REMOTE_UPDATE_INSTALL_BUDGET_MS,
  REMOTE_UPDATE_RESTART_BUDGET_MS,
} from "@bibcode/client-runtime/state/remoteUpdateCoordinator";

import { MOCK_UPDATE_LOOPBACK_HOST, MOCK_UPDATE_READY_PATH } from "./mock-update-server.ts";
import { requireReleaseTarget, type TauriUpdaterTarget } from "./lib/release-targets.ts";
import {
  releaseCargoLockFile,
  releasePackageFiles,
  releaseRustPackageFiles,
  releaseVersionFiles,
} from "./update-release-package-versions.ts";

export type SeededUpgradePlatform = "linux" | "mac" | "win";
export type SeededUpgradeArch = "arm64" | "x64";
export type SeededUpgradeLane = "previous-stable" | "protected-baseline" | "remote-install";
export type SeededUpgradeTrigger = "local-bridge" | "remote-rpc";

const credentialFailureMilestones = [
  "credential-wide-bootstrap-read-failed",
  "credential-loopback-bootstrap-read-failed",
  "credential-wide-bootstrap-unavailable",
  "credential-loopback-bootstrap-unavailable",
  "credential-wide-bearer-failed",
  "credential-wide-request-failed",
  "credential-wide-request-aborted",
  "credential-wide-http-401",
  "credential-wide-http-403",
  "credential-wide-http-other",
  "credential-wide-body-invalid",
  "credential-wide-list-invalid",
  "credential-wide-grant-deadline",
] as const;

const seededStepMilestones = [
  "spec-loaded",
  "test-entered",
  "bridge-wait",
  "bridge-ready",
  "observation-started",
  "observation-returned",
  "baseline-verified",
  "sharing-started",
  "sharing-finished",
  "credential-wide-request-started",
  "credential-loopback-request-started",
  "credential-wide-result-invalid",
  "credential-loopback-result-invalid",
  ...credentialFailureMilestones,
  "credential-request-returned",
  "credential-receipt-published",
] as const;

const MOCK_UPDATE_READY_TIMEOUT_MS = 60_000;

/** Closed deadline facts only; accessors and foreign fields never become evidence. */
function decodeSeededGrantDeadline(value: unknown) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = [
      "offerState",
      "pollAttempts",
      "listResponses",
      "lastListCount",
      "eligibleShapeSeen",
    ];
    if (Reflect.ownKeys(value).length !== keys.length) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const field = (key: string): unknown => {
      const descriptor = descriptors[key];
      return descriptor?.enumerable && Object.hasOwn(descriptor, "value")
        ? descriptor.value
        : undefined;
    };
    const offerState = field("offerState");
    const pollAttempts = field("pollAttempts");
    const listResponses = field("listResponses");
    const lastListCount = field("lastListCount");
    const eligibleShapeSeen = field("eligibleShapeSeen");
    const bounded = (count: unknown, maximum: number): count is number | null =>
      count === null ||
      (typeof count === "number" && Number.isSafeInteger(count) && count >= 0 && count <= maximum);
    if (
      typeof offerState !== "string" ||
      !["generating", "generated", "known-failure", "unknown"].includes(offerState) ||
      !bounded(pollAttempts, 80) ||
      !bounded(listResponses, 80) ||
      !bounded(lastListCount, 1024) ||
      (eligibleShapeSeen !== null && typeof eligibleShapeSeen !== "boolean") ||
      pollAttempts !== listResponses ||
      (listResponses === 1 && lastListCount === 0 && eligibleShapeSeen === true) ||
      (listResponses === 0 && (lastListCount !== null || eligibleShapeSeen !== null)) ||
      (listResponses !== 0 && eligibleShapeSeen === null)
    )
      return null;
    return { offerState, pollAttempts, listResponses, lastListCount, eligibleShapeSeen };
  } catch {
    return null;
  }
}

export interface SeededDesktopUpgradeSmokeInput {
  readonly arch: SeededUpgradeArch;
  readonly artifactDirectory: string;
  readonly bundle: "appimage" | "dmg" | "nsis";
  readonly candidateVersion: string;
  readonly platform: SeededUpgradePlatform;
  readonly previousTag: string;
  readonly previousVersion: string;
  readonly previousStableTrigger?: SeededUpgradeTrigger;
  readonly publicKeyFile: string;
  readonly repositoryRoot: string;
  readonly restartTimeoutMs: number;
  readonly runId: string;
  readonly updaterPort: number;
  readonly wsl: boolean;
  readonly workRoot: string;
}

interface SeededUpgradeLaneLayout {
  readonly buildRoot: string;
  readonly checkout: string;
  readonly dataRoot: string;
  readonly evidenceDirectory: string;
  readonly workspaceRoot: string;
}

export interface SeededUpgradeRunLayout {
  readonly candidateBuildRoot: string;
  readonly candidateCheckout: string;
  readonly previousStable: SeededUpgradeLaneLayout;
  readonly protectedBaseline: SeededUpgradeLaneLayout;
  readonly remoteInstall: SeededUpgradeLaneLayout;
  readonly updaterRoot: string;
}

export interface SeededUpgradeObservationBefore {
  readonly appVersion: string | null;
  readonly effectiveRoot: string;
  readonly projectId: string;
  readonly projectIds: ReadonlyArray<string>;
  readonly storageInstanceId: string | null;
}

export interface SeededUpgradeObservationAfter {
  readonly appVersion: string | null;
  readonly effectiveRoot: string;
  readonly projectIds: ReadonlyArray<string>;
  readonly storageInstanceId: string | null;
  readonly preUpdateBackups: ReadonlyArray<{
    readonly storageInstanceId: string;
    readonly trigger: string;
  }>;
}

export class SeededDesktopUpgradeSmokeError extends Error {
  override readonly name = "SeededDesktopUpgradeSmokeError";
}

const previousStableTrigger = (
  value: unknown,
  platform: SeededUpgradePlatform,
  wsl: boolean,
): SeededUpgradeTrigger => {
  const trigger = value === undefined ? "local-bridge" : value;
  if (trigger !== "local-bridge" && trigger !== "remote-rpc") {
    throw new SeededDesktopUpgradeSmokeError(
      "--previous-stable-trigger must be local-bridge or remote-rpc.",
    );
  }
  if (trigger === "remote-rpc" && (platform !== "win" || wsl)) {
    throw new SeededDesktopUpgradeSmokeError(
      "The previous-stable RPC trigger requires native Windows.",
    );
  }
  return trigger;
};

const UPGRADE_SOURCE_PATHS = [
  "apps/desktop/src-tauri/src/bridge.rs",
  "apps/desktop/src-tauri/src/firewall.rs",
  "apps/desktop/src-tauri/src/updates.rs",
  "apps/desktop/src-tauri/src/remote_update_delegate.rs",
  "apps/server/src/remote_update.rs",
  "apps/server/src/production/remote_update_rpc.rs",
  "apps/server/src/auth/http.rs",
  "apps/server/src/maintenance.rs",
] as const;
const MAX_VERSION_SOURCE_BYTES = 262_144;

/** The canonical transaction may change version fields and serialization, never other values. */
export function assertSeededVersionOverlay(
  path: string,
  originalText: string,
  currentText: string,
  version: string,
): void {
  try {
    let expected: unknown;
    let current: unknown;
    if (releasePackageFiles.some((entry) => entry === path)) {
      const original: unknown = JSON.parse(originalText);
      if (
        typeof original !== "object" ||
        original === null ||
        Array.isArray(original) ||
        !("version" in original) ||
        typeof original.version !== "string"
      )
        throw new Error("Invalid package manifest");
      expected = { ...original, version };
      current = JSON.parse(currentText);
    } else if (releaseRustPackageFiles.some((entry) => entry === path)) {
      const original = parseToml(originalText);
      const pkg = original.package;
      if (
        typeof pkg !== "object" ||
        pkg === null ||
        Array.isArray(pkg) ||
        !("version" in pkg) ||
        typeof pkg.version !== "string"
      )
        throw new Error("Invalid Cargo manifest");
      expected = { ...original, package: { ...pkg, version } };
      current = parseToml(currentText);
    } else if (path === releaseCargoLockFile) {
      const original = parseToml(originalText);
      if (!Array.isArray(original.package)) throw new Error("Invalid Cargo lock");
      const seen = new Set<string>();
      const packages = original.package.map((pkg) => {
        if (
          typeof pkg !== "object" ||
          pkg === null ||
          Array.isArray(pkg) ||
          !("name" in pkg) ||
          typeof pkg.name !== "string"
        )
          throw new Error("Invalid locked package");
        if (pkg.name !== "bibcode-server" && pkg.name !== "bibcode-desktop") return pkg;
        if (seen.has(pkg.name) || !("version" in pkg) || typeof pkg.version !== "string")
          throw new Error("Invalid release package");
        seen.add(pkg.name);
        return { ...pkg, version };
      });
      if (seen.size !== 2) throw new Error("Missing release packages");
      expected = { ...original, package: packages };
      current = parseToml(currentText);
    } else throw new Error("Not a declared version file");
    if (!NodeUtil.isDeepStrictEqual(current, expected))
      throw new Error("Non-version values changed");
  } catch {
    throw new SeededDesktopUpgradeSmokeError(
      "The declared version overlay did not match the source.",
    );
  }
}

/** Bounded source facts are planned coverage; ordinary lane verifiers alone publish success. */
export function createSeededUpgradeProvenance(input: {
  readonly lane: SeededUpgradeLane;
  readonly trigger: SeededUpgradeTrigger;
  readonly sourceRef: string;
  readonly sourceCommit: string;
  readonly baselineVersion: string;
  readonly candidateVersion: string;
  readonly sourceHashes: Readonly<Record<string, string>>;
}) {
  try {
    if (
      !["previous-stable", "protected-baseline", "remote-install"].includes(input.lane) ||
      !["local-bridge", "remote-rpc"].includes(input.trigger) ||
      !/^[a-f0-9]{40}$/.test(input.sourceCommit) ||
      input.baselineVersion.length > 128 ||
      input.candidateVersion.length > 128 ||
      input.sourceRef !==
        (input.lane === "previous-stable" ? `v${input.baselineVersion}` : input.sourceCommit) ||
      Object.keys(input.sourceHashes).length !== UPGRADE_SOURCE_PATHS.length ||
      !UPGRADE_SOURCE_PATHS.every((path) => /^[a-f0-9]{64}$/.test(input.sourceHashes[path] ?? ""))
    )
      throw new Error("Invalid source facts");
    assertBaselineVersionIsOlder(input.baselineVersion, input.candidateVersion);
  } catch {
    throw new SeededDesktopUpgradeSmokeError("The upgrade source provenance is invalid.");
  }
  const excludesOldLocal = input.lane === "previous-stable" && input.trigger === "remote-rpc";
  return {
    schemaVersion: 1,
    lane: input.lane,
    trigger: input.trigger,
    sourceKind: input.lane === "previous-stable" ? "tag-source-rebuild" : "current-source-rebuild",
    sourceRef: input.sourceRef,
    sourceCommit: input.sourceCommit,
    sourceFiles: UPGRADE_SOURCE_PATHS.map((path) => ({ path, sha256: input.sourceHashes[path]! })),
    baselineVersion: input.baselineVersion,
    candidateVersion: input.candidateVersion,
    instrumentationApplied: false,
    trackedSourcePolicy: "all-tracked-with-validated-version-fields",
    permittedVersionOverlayFiles: [...releaseVersionFiles],
    packaging: { profile: "release", desktopE2e: true, ephemeralUpdaterOverlay: true },
    protectionRequired: input.lane !== "previous-stable" || input.trigger === "remote-rpc",
    coverageStatus: "selected-not-yet-verified",
    excludedEntryPoints: excludesOldLocal ? ["previous-stable-local-bridge"] : [],
    knownPriorFailure:
      excludesOldLocal && input.sourceRef === "v0.7.2"
        ? "previous-stable-local-bridge-stack-overflow"
        : null,
  };
}

export const REMOTE_INSTALL_FORBIDDEN_PORTS: ReadonlySet<number> = new Set([
  3773, 5733, 13773, 18431, 18432,
]);
export function assertRemoteInstallPort(port: number): number {
  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    REMOTE_INSTALL_FORBIDDEN_PORTS.has(port)
  ) {
    throw new SeededDesktopUpgradeSmokeError(
      "The remote-install lane needs an unreserved high port.",
    );
  }
  return port;
}
export function countAppImageMounts(procMounts: string, prefix: string): number {
  return procMounts
    .split("\n")
    .filter((line) => NodePath.posix.basename(line.split(" ")[1] ?? "").startsWith(prefix)).length;
}
export interface RemoteHeldUploadEvidence {
  readonly admitted: boolean;
  readonly releasedOnWaitingStage: boolean;
  readonly completed: boolean;
  readonly bytesMatch: boolean;
  readonly noPartials: boolean;
  readonly requestClosed: boolean;
  readonly holdLimitMs: number;
}
export interface RemoteInstallEvidence {
  readonly before: {
    readonly bootId: string;
    readonly serverVersion: string;
    readonly storageInstanceId: string;
  };
  readonly after: {
    readonly bootId: string;
    readonly serverVersion: string;
    readonly storageInstanceId: string;
  };
  readonly phases: ReadonlyArray<string>;
  readonly sawPercent: boolean;
  readonly sawStage: boolean;
  readonly heldUpload: RemoteHeldUploadEvidence;
  readonly preUpdateBackups: number;
  readonly requesterLogLines: number;
  readonly appImageMounts: number | null;
  readonly runtimeProcesses: number | null;
}
export function verifyRemoteInstallOutcome(
  evidence: RemoteInstallEvidence,
  candidateVersion: string,
): void {
  const fail = (message: string): never => {
    throw new SeededDesktopUpgradeSmokeError(`remote-install: ${message}`);
  };
  if (
    evidence.before.bootId.length === 0 ||
    evidence.after.bootId.length === 0 ||
    evidence.before.bootId === evidence.after.bootId
  )
    fail("the host did not publish a new boot.");
  if (evidence.after.serverVersion !== candidateVersion)
    fail("the candidate version is not running.");
  if (
    evidence.before.storageInstanceId.length === 0 ||
    evidence.after.storageInstanceId !== evidence.before.storageInstanceId
  )
    fail("storage identity was not retained.");
  if (!evidence.phases.includes("succeeded")) fail("the coordinator did not succeed.");
  if (!evidence.sawPercent || !evidence.sawStage)
    fail("download and protection progress was not observed.");
  const held = evidence.heldUpload;
  if (
    !held ||
    held.admitted !== true ||
    held.releasedOnWaitingStage !== true ||
    held.completed !== true ||
    held.bytesMatch !== true ||
    held.noPartials !== true ||
    held.requestClosed !== true ||
    held.holdLimitMs !== 20_000
  )
    fail("the owned held upload witness was not completed.");
  if (evidence.preUpdateBackups < 1) fail("no pre-update backup was observed.");
  if (evidence.requesterLogLines !== 1) fail("expected exactly one requester log entry.");
  if (evidence.appImageMounts !== null && evidence.appImageMounts !== 1)
    fail("expected one AppImage mount.");
  if (evidence.runtimeProcesses !== null && evidence.runtimeProcesses !== 1)
    fail("expected one AppImage runtime.");
}
export function scopedCleanupPids(
  processes: ReadonlyArray<{
    readonly pid: number;
    readonly comm: string;
    readonly environ: string;
  }>,
  home: string,
): ReadonlyArray<number> {
  return processes
    .filter((entry) => entry.environ.split("\0").includes(`BIBCODE_HOME=${home}`))
    .map((entry) => entry.pid);
}

const requireString = (values: Record<string, unknown>, name: string): string => {
  const value = values[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SeededDesktopUpgradeSmokeError(`--${name} is required.`);
  }
  return value.trim();
};

const parsePositiveInteger = (raw: unknown, name: string, defaultValue: number): number => {
  const value = raw === undefined ? defaultValue : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SeededDesktopUpgradeSmokeError(`--${name} must be a positive integer.`);
  }
  return value;
};

const requireAbsolute = (value: string, name: string): string => {
  if (!NodePath.isAbsolute(value)) {
    throw new SeededDesktopUpgradeSmokeError(`--${name} must be an absolute path.`);
  }
  return NodePath.resolve(value);
};

export function parseSeededDesktopUpgradeSmokeArgs(
  argv: ReadonlyArray<string>,
  repositoryRoot = process.cwd(),
): SeededDesktopUpgradeSmokeInput {
  let values: Record<string, unknown>;
  try {
    ({ values } = NodeUtil.parseArgs({
      args: [...argv],
      allowPositionals: false,
      strict: true,
      options: {
        arch: { type: "string" },
        "artifact-dir": { type: "string" },
        bundle: { type: "string" },
        "candidate-version": { type: "string" },
        platform: { type: "string" },
        "previous-tag": { type: "string" },
        "previous-version": { type: "string" },
        "previous-stable-trigger": { type: "string" },
        "public-key-file": { type: "string" },
        "restart-timeout-ms": { type: "string" },
        "run-id": { type: "string" },
        "updater-port": { type: "string" },
        "work-root": { type: "string" },
        wsl: { type: "boolean", default: false },
      },
    }));
  } catch (cause) {
    throw new SeededDesktopUpgradeSmokeError(
      cause instanceof Error ? cause.message : "Invalid packaged-upgrade arguments.",
    );
  }

  const platform = requireString(values, "platform");
  const arch = requireString(values, "arch");
  const bundle = requireString(values, "bundle");
  if (platform !== "linux" && platform !== "mac" && platform !== "win") {
    throw new SeededDesktopUpgradeSmokeError(`Unsupported platform ${platform}.`);
  }
  if (arch !== "arm64" && arch !== "x64") {
    throw new SeededDesktopUpgradeSmokeError(`Unsupported architecture ${arch}.`);
  }
  const expectedBundle = platform === "linux" ? "appimage" : platform === "mac" ? "dmg" : "nsis";
  if (bundle !== expectedBundle) {
    throw new SeededDesktopUpgradeSmokeError(
      `${platform} packaged upgrades require the ${expectedBundle} bundle.`,
    );
  }
  if (values.wsl === true && (platform !== "win" || arch !== "x64")) {
    throw new SeededDesktopUpgradeSmokeError("WSL upgrade coverage requires Windows x64.");
  }
  const updaterPort = parsePositiveInteger(values["updater-port"], "updater-port", 43_120);
  const highestPortOffset = values.wsl === true ? 102 : 103;
  if (updaterPort + highestPortOffset > 65_535) {
    throw new SeededDesktopUpgradeSmokeError(
      "--updater-port must leave room for the isolated backend and WebDriver ports.",
    );
  }

  return {
    arch,
    artifactDirectory: requireAbsolute(requireString(values, "artifact-dir"), "artifact-dir"),
    bundle,
    candidateVersion: requireString(values, "candidate-version"),
    platform,
    previousTag: requireString(values, "previous-tag"),
    previousVersion: requireString(values, "previous-version"),
    previousStableTrigger: previousStableTrigger(
      values["previous-stable-trigger"],
      platform,
      values.wsl === true,
    ),
    publicKeyFile: requireAbsolute(requireString(values, "public-key-file"), "public-key-file"),
    repositoryRoot: NodePath.resolve(repositoryRoot),
    restartTimeoutMs: parsePositiveInteger(
      values["restart-timeout-ms"],
      "restart-timeout-ms",
      120_000,
    ),
    runId: requireString(values, "run-id"),
    updaterPort,
    wsl: values.wsl === true,
    workRoot: requireAbsolute(requireString(values, "work-root"), "work-root"),
  };
}

const laneLayout = (runRoot: string, name: string): SeededUpgradeLaneLayout => {
  const root = NodePath.join(runRoot, name);
  return {
    buildRoot: NodePath.join(root, "build"),
    checkout: NodePath.join(root, "checkout"),
    dataRoot: NodePath.join(root, "data"),
    evidenceDirectory: NodePath.join(root, "evidence"),
    workspaceRoot: NodePath.join(root, "workspace"),
  };
};

export function createSeededUpgradeRunLayout(
  workRoot: string,
  runId: string,
): SeededUpgradeRunLayout {
  if (!NodePath.isAbsolute(workRoot)) {
    throw new SeededDesktopUpgradeSmokeError("The seeded-upgrade work root must be absolute.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
    throw new SeededDesktopUpgradeSmokeError("The seeded-upgrade run id is invalid.");
  }
  const runRoot = NodePath.join(NodePath.resolve(workRoot), runId);
  return {
    candidateBuildRoot: NodePath.join(runRoot, "candidate-build"),
    candidateCheckout: NodePath.join(runRoot, "candidate-checkout"),
    previousStable: laneLayout(runRoot, "previous"),
    protectedBaseline: laneLayout(runRoot, "protected"),
    remoteInstall: laneLayout(runRoot, "remote"),
    updaterRoot: NodePath.join(runRoot, "updater"),
  };
}

export async function canonicalizeSeededUpgradeWorkRoot(workRoot: string): Promise<string> {
  if (!NodePath.isAbsolute(workRoot)) {
    throw new SeededDesktopUpgradeSmokeError("The seeded-upgrade work root must be absolute.");
  }
  await NodeFS.promises.mkdir(workRoot, { recursive: true, mode: 0o700 });
  const canonical = await NodeFS.promises.realpath(workRoot);
  const metadata = await NodeFS.promises.stat(canonical);
  if (!metadata.isDirectory()) {
    throw new SeededDesktopUpgradeSmokeError(
      "The seeded-upgrade work root must resolve to a directory.",
    );
  }
  return canonical;
}

export function buildSeededUpgradeOverlay(input: {
  readonly endpoint: string;
  readonly identifier: string;
  readonly publicKey: string;
  readonly version: string;
}): Record<string, unknown> {
  const endpoint = new URL(input.endpoint);
  if (
    endpoint.protocol !== "http:" ||
    (endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost")
  ) {
    throw new SeededDesktopUpgradeSmokeError("The test updater endpoint must be loopback HTTP.");
  }
  if (input.publicKey.trim().length === 0) {
    throw new SeededDesktopUpgradeSmokeError("The test updater public key is required.");
  }
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*){2,}$/.test(input.identifier)) {
    throw new SeededDesktopUpgradeSmokeError("The test application identifier is invalid.");
  }
  return {
    identifier: input.identifier,
    version: input.version,
    bundle: { createUpdaterArtifacts: true },
    plugins: {
      updater: {
        // This overlay is generated only for the isolated loopback smoke server. Released
        // configuration remains HTTPS-only; old release builds otherwise abort before startup.
        dangerousInsecureTransportProtocol: true,
        endpoints: [endpoint.toString()],
        pubkey: input.publicKey.trim(),
      },
    },
  };
}

export function buildLocalUpdaterManifest(input: {
  readonly artifact: string;
  readonly baseUrl: string;
  readonly candidateVersion: string;
  readonly signature: string;
  readonly target: TauriUpdaterTarget;
}): Record<string, unknown> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._()+ -]*$/.test(input.artifact)) {
    throw new SeededDesktopUpgradeSmokeError("The updater artifact must be a safe basename.");
  }
  const baseUrl = new URL(input.baseUrl);
  if (
    baseUrl.protocol !== "http:" ||
    (baseUrl.hostname !== "127.0.0.1" && baseUrl.hostname !== "localhost")
  ) {
    throw new SeededDesktopUpgradeSmokeError("The test update manifest must use loopback HTTP.");
  }
  return {
    version: input.candidateVersion,
    notes: "BiBCode seeded packaged-upgrade smoke",
    pub_date: "2026-01-01T00:00:00Z",
    platforms: {
      [input.target]: {
        signature: input.signature.trim(),
        url: new URL(
          encodeURIComponent(input.artifact).replace(/%2F/gi, "%252F"),
          baseUrl,
        ).toString(),
      },
    },
  };
}

export function createSeededUpgradeDriverSpec(input: {
  readonly candidateVersion: string;
  readonly baselineVersion?: string | undefined;
  readonly expectedDataRoot: string;
  readonly lane: SeededUpgradeLane;
  readonly trigger?: SeededUpgradeTrigger;
  readonly phase: "seed-and-install" | "verify";
  readonly projectId: string;
  readonly resultPath: string;
  readonly workspaceRoot: string;
  readonly wsl?: boolean | undefined;
  readonly remoteInstallDriverPath?: string;
  readonly remoteHarnessPath?: string;
  readonly remoteSecretPath?: string;
  readonly remoteUploadSecretPath?: string;
  readonly remoteEvidencePath?: string;
  readonly appBinaryPath?: string;
  readonly platform?: SeededUpgradePlatform;
  readonly stepStatusPath?: string;
}): string {
  const trigger =
    input.trigger ?? (input.lane === "remote-install" ? "remote-rpc" : "local-bridge");
  if (
    input.lane === "previous-stable" &&
    trigger === "remote-rpc" &&
    input.baselineVersion === undefined
  ) {
    throw new SeededDesktopUpgradeSmokeError(
      "The previous RPC phase requires a planned baseline version.",
    );
  }
  if (
    trigger === "remote-rpc" &&
    input.phase === "seed-and-install" &&
    (!input.remoteInstallDriverPath ||
      !input.remoteHarnessPath ||
      !input.remoteSecretPath ||
      !input.remoteUploadSecretPath ||
      !input.remoteEvidencePath ||
      !input.appBinaryPath ||
      !input.platform)
  ) {
    throw new SeededDesktopUpgradeSmokeError(
      "The remote-install phase requires private receipts, helper paths, and its isolated application.",
    );
  }
  const serializedInput = JSON.stringify(input).replaceAll("<", "\\u003c");
  return `
// Generated by scripts/seeded-desktop-upgrade-smoke.ts. Never persist database contents here.
import * as NodeFS from "node:fs";

const input = ${serializedInput};

// Private, best-effort checkpoint only. It never authorizes raw evidence retention.
function publishStep(milestone, grantDeadline = null) {
  if (typeof input.stepStatusPath !== "string" ||
      !${JSON.stringify(seededStepMilestones)}.includes(milestone)) return;
  const temporary = input.stepStatusPath + ".tmp";
  let owned = false;
  try {
    const fd = NodeFS.openSync(temporary, "wx", 0o600);
    owned = true;
    try {
      NodeFS.writeFileSync(fd, JSON.stringify({
        version: 1, lane: input.lane, phase: input.phase,
        trigger: ${JSON.stringify(trigger)}, milestone,
        ...(grantDeadline === null ? {} : { grantDeadline }),
      }) + "\\n");
    } finally { NodeFS.closeSync(fd); }
    NodeFS.renameSync(temporary, input.stepStatusPath);
  } catch {
    // Diagnostic failure must not change the test, its exception, or cleanup.
  } finally {
    if (owned) try { NodeFS.unlinkSync(temporary); } catch {}
  }
}
const decodeSeededGrantDeadline = ${decodeSeededGrantDeadline.toString()};
publishStep("spec-loaded");

async function waitForDesktopBridge() {
  publishStep("bridge-wait");
  await browser.waitUntil(
    async () => browser.execute(() => Boolean(window.desktopBridge)),
    {
      timeout: 60000,
      interval: 100,
      timeoutMsg: "The packaged desktop bridge did not become ready.",
    },
  );
  publishStep("bridge-ready");
}

async function observe(seed) {
  await waitForDesktopBridge();
  publishStep("observation-started");
  return browser.execute(async (parameters, seed) => {
    const bridge = window.desktopBridge;
    if (!bridge) throw new Error("The packaged desktop bridge is unavailable.");
    if (parameters.wsl && seed) {
      if (
        typeof bridge.setWslOnly !== "function" ||
        typeof bridge.setWslBackendEnabled !== "function"
      ) {
        throw new Error("The packaged desktop bridge cannot configure WSL.");
      }
      await bridge.setWslOnly(true);
      await bridge.setWslBackendEnabled(true);
    }
    const bootstrap = await new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const poll = () => {
        const candidate = bridge
          .getLocalEnvironmentBootstraps()
          .find((entry) => entry.id === "primary");
        const isReady =
          candidate?.httpBaseUrl &&
          candidate?.wsBaseUrl &&
          (!parameters.wsl || typeof candidate.runningDistro === "string");
        if (isReady) return resolve(candidate);
        if (Date.now() - startedAt >= 60000) {
          return reject(new Error("The packaged primary bootstrap did not become ready."));
        }
        setTimeout(poll, 100);
      };
      poll();
    });
    if (!bootstrap || !bootstrap.httpBaseUrl || !bootstrap.wsBaseUrl) {
      throw new Error("The packaged primary bootstrap is unavailable.");
    }
    const bearer = await bridge.getLocalEnvironmentBearerToken();
    const descriptorResponse = await fetch(
      new URL("/.well-known/bibcode/environment", bootstrap.httpBaseUrl),
    );
    if (!descriptorResponse.ok) {
      throw new Error("The environment descriptor request failed.");
    }
    const descriptor = await descriptorResponse.json();
    const ticketResponse = await fetch(
      new URL("/api/auth/websocket-ticket", bootstrap.httpBaseUrl),
      { method: "POST", headers: { authorization: "Bearer " + bearer } },
    );
    if (!ticketResponse.ok) throw new Error("The WebSocket ticket request failed.");
    const ticket = (await ticketResponse.json()).ticket;
    if (typeof ticket !== "string" || ticket.length === 0) {
      throw new Error("The WebSocket ticket response was invalid.");
    }
    const socketUrl = new URL(bootstrap.wsBaseUrl);
    if (socketUrl.pathname === "" || socketUrl.pathname === "/") socketUrl.pathname = "/ws";
    socketUrl.searchParams.set("wsTicket", ticket);
    const socket = new WebSocket(socketUrl);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out opening RPC.")), 15000);
      socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("RPC failed.")); }, { once: true });
    });
    let sequence = 0;
    const request = (tag, payload, stream = false) => new Promise((resolve, reject) => {
      const requestId = String(sequence++);
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for " + tag + ".")), 15000);
      const onMessage = (event) => {
        if (typeof event.data !== "string") return;
        const message = JSON.parse(event.data);
        if (message.requestId !== requestId) return;
        if (stream && message._tag === "Chunk") {
          clearTimeout(timeout);
          socket.removeEventListener("message", onMessage);
          socket.send(JSON.stringify({ _tag: "Interrupt", requestId }));
          resolve(message.values?.[0] ?? null);
          return;
        }
        if (!stream && message._tag === "Exit") {
          clearTimeout(timeout);
          socket.removeEventListener("message", onMessage);
          if (message.exit?._tag !== "Success") reject(new Error("RPC " + tag + " failed."));
          else resolve(message.exit.value ?? null);
        }
      };
      socket.addEventListener("message", onMessage);
      socket.send(JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] }));
    });
    if (seed) {
      await request("orchestration.dispatchCommand", {
        type: "project.create",
        commandId: "seed-" + parameters.projectId,
        projectId: parameters.projectId,
        title: "Seeded upgrade project",
        workspaceRoot: parameters.workspaceRoot,
        createWorkspaceRootIfMissing: true,
        initializeGit: false,
        defaultModelSelection: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    }
    const shellEnvelope = await request("orchestration.subscribeShell", {}, true);
    const shell = shellEnvelope?.kind === "snapshot" ? shellEnvelope.snapshot : null;
    const projectIds = Array.isArray(shell?.projects)
      ? shell.projects.map((project) => project?.id).filter((id) => typeof id === "string")
      : [];
    socket.close();
    let effectiveRoot = parameters.expectedDataRoot;
    let preUpdateBackups = [];
    if (typeof bridge.getProjectDataStatuses === "function") {
      const statuses = await bridge.getProjectDataStatuses();
      const primary = statuses.find((status) => status.environmentId === "primary");
      if (primary) {
        if (typeof primary.effectiveRoot === "string") effectiveRoot = primary.effectiveRoot;
        if (Array.isArray(primary.backups)) {
          preUpdateBackups = primary.backups.map((backup) => ({
            ...backup,
            storageInstanceId: primary.storageInstanceId,
          }));
        }
      }
    }
    const updateState =
      typeof bridge.getUpdateState === "function" ? await bridge.getUpdateState() : null;
    return {
      appVersion:
        typeof updateState?.currentVersion === "string" ? updateState.currentVersion : null,
      effectiveRoot,
      projectId: parameters.projectId,
      projectIds,
      storageInstanceId:
        typeof descriptor?.storageInstanceId === "string" ? descriptor.storageInstanceId : null,
      preUpdateBackups,
    };
  }, {
    expectedDataRoot: input.expectedDataRoot,
    projectId: input.projectId,
    workspaceRoot: input.workspaceRoot,
    wsl: input.wsl === true,
  }, seed);
}

describe("seeded packaged upgrade ${input.lane} ${input.phase}", () => {
  it("uses public desktop and authenticated RPC boundaries", async () => {
    publishStep("test-entered");
    const observation = await observe(${input.phase === "seed-and-install" ? "true" : "false"});
    publishStep("observation-returned");
    ${
      input.phase === "seed-and-install" && input.baselineVersion !== undefined
        ? `
    if (observation.appVersion !== input.baselineVersion) {
      throw new Error("The starting app version did not match the planned baseline.");
    }
    publishStep("baseline-verified");`
        : ""
    }
    NodeFS.writeFileSync(input.resultPath, JSON.stringify(observation));
    ${
      input.phase === "seed-and-install" && trigger === "remote-rpc"
        ? `
    publishStep("sharing-started");
    await browser.execute(() => { window.location.hash = "/settings/remote-servers?tab=share"; });
    let widened = false;
    try {
      await browser.waitUntil(async () => browser.execute(() => [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Generate pairing offer")), { timeout: 30000, interval: 100 });
      const generated = await browser.execute(() => {
        const button = [...document.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === "Generate pairing offer");
        if (!button || button.disabled) return false;
        button.click(); return true;
      });
      if (generated) await browser.waitUntil(async () => browser.execute(async () => (await window.desktopBridge.getServerExposureState()).mode === "network-accessible"), { timeout: 60000, interval: 250 });
      widened = generated;
    } catch { widened = false; }
    publishStep("sharing-finished");
    publishStep(widened ? "credential-wide-request-started" : "credential-loopback-request-started");
    const credentialResult = await browser.execute(async (widened) => {
      const refuse = (stage) => ({
        _tag: "seeded-credential-failure",
        milestone: (widened ? "credential-wide-" : "credential-loopback-") + stage,
      });
      let bootstrap;
      try {
        bootstrap = window.desktopBridge.getLocalEnvironmentBootstraps().find((entry) => entry.id === "primary");
      } catch { return refuse("bootstrap-read-failed"); }
      if (!bootstrap?.httpBaseUrl || !bootstrap.bootstrapToken) return refuse("bootstrap-unavailable");
      if (widened) {
        let bearer;
        try { bearer = await window.desktopBridge.getLocalEnvironmentBearerToken(); }
        catch { return refuse("bearer-failed"); }
        // Exposure precedes minting. Stay below the embedded driver's 30-second command bound.
        const deadline = Date.now() + 20000;
        let pollAttempts = 0, listResponses = 0, lastListCount = null, eligibleShapeSeen = null;
        const increment = (count) => count !== null && count < 80 ? count + 1 : null;
        while (Date.now() < deadline) {
          pollAttempts = increment(pollAttempts);
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), Math.min(5000, deadline - Date.now()));
          let links;
          try {
            let response;
            try {
              response = await fetch(new URL("/api/auth/pairing-links", bootstrap.httpBaseUrl), {
                headers: { authorization: "Bearer " + bearer },
                signal: controller.signal,
              });
            } catch { return refuse(controller.signal.aborted ? "request-aborted" : "request-failed"); }
            if (!response.ok) return refuse(response.status === 401 ? "http-401" : response.status === 403 ? "http-403" : "http-other");
            try { links = await response.json(); }
            catch { return refuse(controller.signal.aborted ? "request-aborted" : "body-invalid"); }
          } finally {
            clearTimeout(timeout);
          }
          if (!Array.isArray(links)) return refuse("list-invalid");
          listResponses = increment(listResponses);
          lastListCount = links.length <= 1024 ? links.length : null;
          // AuthPairingLink publishes reach and credential; offHost is server-private metadata.
          const grant = links.find((link) => link !== null && typeof link === "object" &&
            link.reach === "another-device" && typeof link.id === "string" && link.id.trim().length > 0 &&
            typeof link.credential === "string" && link.credential.trim().length > 0);
          eligibleShapeSeen = eligibleShapeSeen === true || Boolean(grant);
          if (grant && Date.now() < deadline) {
            // Redeeming the offered grant keeps the wide listener alive across the update.
            return { endpoint: bootstrap.httpBaseUrl, bootstrapToken: grant.credential };
          }
          await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(250, deadline - Date.now()))));
        }
        let offerState = "unknown";
        try {
          const candidates = document.querySelectorAll("section");
          const sections = candidates.length > 32 ? [] : [...candidates].filter((section) =>
            section.querySelector("h2")?.textContent?.trim() === "Offer generator");
          if (sections.length === 1) {
            const section = sections[0];
            const buttons = section.querySelectorAll("button");
            if (buttons.length > 32) throw new Error();
            const generating = [...buttons].some((button) =>
              button.disabled && button.textContent?.trim() === "Generating…");
            const generated = Boolean(section.querySelector('svg[role="img"][aria-label="Pairing code — scan with a BiBCode client"]'));
            const failed = Boolean(section.querySelector(":scope > div > p.text-destructive"));
            if (Number(generating) + Number(generated) + Number(failed) === 1)
              offerState = generating ? "generating" : generated ? "generated" : "known-failure";
          }
        } catch { /* Unavailable or changed DOM stays unknown; no error text is inspected. */ }
        return { ...refuse("grant-deadline"), grantDeadline: {
          offerState, pollAttempts, listResponses, lastListCount, eligibleShapeSeen,
        } };
      }
      return { endpoint: bootstrap.httpBaseUrl, bootstrapToken: bootstrap.bootstrapToken };
    }, widened);
    // Reconstruct only finite callback facts; arbitrary WebDriver results are never receipts.
    const resultIsRecord = credentialResult !== null && typeof credentialResult === "object" && !Array.isArray(credentialResult);
    const resultKeys = resultIsRecord ? Reflect.ownKeys(credentialResult) : [];
    const field = (name) => {
      const descriptor = resultIsRecord ? Object.getOwnPropertyDescriptor(credentialResult, name) : undefined;
      return descriptor?.enumerable && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
    };
    const failureMilestone = field("milestone");
    const isDeadline = widened && failureMilestone === "credential-wide-grant-deadline";
    const grantDeadline = isDeadline ? decodeSeededGrantDeadline(field("grantDeadline")) : null;
    if (resultKeys.length === (isDeadline ? 3 : 2) && (!isDeadline || grantDeadline !== null) && field("_tag") === "seeded-credential-failure" &&
        ${JSON.stringify(credentialFailureMilestones)}.includes(failureMilestone) &&
        failureMilestone.startsWith(widened ? "credential-wide-" : "credential-loopback-")) {
      publishStep(failureMilestone, grantDeadline);
      const message = failureMilestone.endsWith("bootstrap-unavailable") ? "Remote verification bootstrap unavailable."
        : failureMilestone.endsWith("bootstrap-read-failed") ? "Remote verification bootstrap read failed."
        : failureMilestone.endsWith("bearer-failed") ? "Remote verification bearer acquisition failed."
        : failureMilestone.endsWith("list-invalid") ? "Remote verification pairing grant response invalid."
        : failureMilestone.endsWith("grant-deadline") ? "Remote verification has no live native sharing grant."
        : "Remote verification pairing grant unavailable.";
      throw new Error(message);
    }
    const endpoint = field("endpoint"), bootstrapToken = field("bootstrapToken");
    if (resultKeys.length !== 2 || typeof endpoint !== "string" || endpoint.length === 0 ||
        typeof bootstrapToken !== "string" || bootstrapToken.length === 0) {
      publishStep(widened ? "credential-wide-result-invalid" : "credential-loopback-result-invalid");
      throw new Error("Remote verification credential response invalid.");
    }
    const credentials = { endpoint, bootstrapToken };
    publishStep("credential-request-returned");
    // Private receipt is outside retained evidence; the controller uses it to redact logs.
    NodeFS.writeFileSync(input.remoteSecretPath, JSON.stringify(credentials), { mode: 0o600 });
    publishStep("credential-receipt-published");
    NodeFS.writeFileSync(input.resultPath, JSON.stringify({ ...observation, installAttempted: false }));
    const { runRemoteInstallDriver } = await import(input.remoteInstallDriverPath);
    const evidence = await runRemoteInstallDriver({
      ...credentials,
      candidateVersion: input.candidateVersion,
      workspaceRoot: input.workspaceRoot,
      uploadReceiptPath: input.remoteUploadSecretPath,
      requireWide: widened,
      onInstallDispatched: () => {
        NodeFS.writeFileSync(input.resultPath, JSON.stringify({ ...observation, installAttempted: true }));
      },
    });
    const { captureRemoteInstallHostEvidence } = await import(input.remoteHarnessPath);
    const host = await captureRemoteInstallHostEvidence({ dataRoot: input.expectedDataRoot, appBinaryPath: input.appBinaryPath, platform: input.platform });
    NodeFS.writeFileSync(input.remoteEvidencePath, JSON.stringify({ ...evidence, ...host, widened }), { mode: 0o600 });
    `
        : input.phase === "seed-and-install"
          ? `
    const preparation = await browser.executeAsync((candidateVersion, done) => {
      const bridge = window.desktopBridge;
      const observed = [];
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        done({ error: error ?? null, phases: observed });
      };
      Promise.resolve(bridge.onUpdateState?.((state) => {
        if (typeof state?.phase === "string" && !observed.includes(state.phase)) {
          observed.push(state.phase);
        }
      })).then(async () => {
        let check = await bridge.checkForUpdate();
        let state = check?.state;
        const startedAt = Date.now();
        while (true) {
          if (
            state?.status === "available" &&
            state?.availableVersion === candidateVersion
          ) break;
          if (
            state?.status === "downloaded" &&
            state?.downloadedVersion === candidateVersion
          ) return finish(null);
          if (state?.status === "error") return finish("update check failed");
          if (state?.status === "up-to-date") return finish("candidate update was not available");
          if (state?.status === "disabled") return finish("packaged updater was disabled");
          if (Date.now() - startedAt >= 30000) return finish("update check timed out");
          await new Promise((resolve) => setTimeout(resolve, 100));
          state = await bridge.getUpdateState();
          if (state?.status === "idle") {
            check = await bridge.checkForUpdate();
            state = check?.state;
          }
        }
        const download = await bridge.downloadUpdate();
        if (
          download?.completed !== true ||
          download?.state?.downloadedVersion !== candidateVersion
        ) return finish("download did not complete");
        finish(null);
      }).catch((error) => finish(String(error)));
    }, input.candidateVersion);
    if (preparation.error) throw new Error(preparation.error);
    const before = JSON.parse(NodeFS.readFileSync(input.resultPath, "utf8"));
    NodeFS.writeFileSync(input.resultPath, JSON.stringify({
      ...before,
      phases: preparation.phases,
      installAttempted: true,
    }));
    const installation = await browser.executeAsync((lane, done) => {
      const bridge = window.desktopBridge;
      const observed = [];
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        done({ error: error ?? null, phases: observed });
      };
      Promise.resolve(bridge.onUpdateState?.((state) => {
        if (typeof state?.phase === "string" && !observed.includes(state.phase)) {
          observed.push(state.phase);
        }
        if (lane === "protected-baseline" && state?.phase === "protecting") finish(null);
      })).then(async () => {
        const install = await bridge.installUpdate();
        if (install?.completed !== true) return finish("install did not complete");
        if (lane === "previous-stable") setTimeout(() => finish(null), 750);
        else finish(null);
      }).catch((error) => finish(String(error)));
      setTimeout(() => finish("timed out observing updater installation"), 30000);
    }, input.lane);
    if (installation.error) {
      NodeFS.writeFileSync(input.resultPath, JSON.stringify({
        ...before,
        phases: [...preparation.phases, ...installation.phases],
        installAttempted: false,
      }));
      throw new Error(installation.error);
    }
    NodeFS.writeFileSync(input.resultPath, JSON.stringify({
      ...before,
      phases: [...preparation.phases, ...installation.phases],
      installAttempted: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 30000));
    `
          : ""
    }
  });
});
`;
}

interface ParsedSemver {
  readonly core: readonly [number, number, number];
  readonly prerelease: ReadonlyArray<string>;
}

const parseSemver = (version: string): ParsedSemver => {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    );
  if (!match) throw new SeededDesktopUpgradeSmokeError(`Invalid semantic version ${version}.`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  };
};

const compareSemver = (left: ParsedSemver, right: ParsedSemver): number => {
  for (let index = 0; index < 3; index += 1) {
    const difference = left.core[index]! - right.core[index]!;
    if (difference !== 0) return difference;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0
        ? 1
        : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
};

export function assertBaselineVersionIsOlder(
  baselineVersion: string,
  candidateVersion: string,
): void {
  if (compareSemver(parseSemver(baselineVersion), parseSemver(candidateVersion)) >= 0) {
    throw new SeededDesktopUpgradeSmokeError(
      `Baseline ${baselineVersion} must be strictly older than candidate ${candidateVersion}.`,
    );
  }
}

export function verifySeededUpgradeOutcome(
  lane: SeededUpgradeLane,
  before: SeededUpgradeObservationBefore,
  after: SeededUpgradeObservationAfter,
  candidateVersion: string,
  trigger: SeededUpgradeTrigger = "local-bridge",
): void {
  if (after.appVersion !== candidateVersion) {
    throw new SeededDesktopUpgradeSmokeError(
      "The candidate application version was not running after update.",
    );
  }
  if (before.effectiveRoot !== after.effectiveRoot) {
    throw new SeededDesktopUpgradeSmokeError(
      "The effective project-data root changed during update.",
    );
  }
  if (!after.projectIds.includes(before.projectId)) {
    throw new SeededDesktopUpgradeSmokeError("The seeded project is missing after update.");
  }
  if (after.storageInstanceId === null) {
    throw new SeededDesktopUpgradeSmokeError("The candidate did not publish a storage identity.");
  }
  if (lane === "previous-stable" && trigger === "local-bridge") return;
  if (before.storageInstanceId === null) {
    throw new SeededDesktopUpgradeSmokeError(
      "The protected baseline storage identity must not be null.",
    );
  }
  if (before.storageInstanceId !== after.storageInstanceId) {
    throw new SeededDesktopUpgradeSmokeError(
      "The protected storage identity changed during update.",
    );
  }
  if (
    !after.preUpdateBackups.some(
      (backup) =>
        backup.storageInstanceId === before.storageInstanceId && backup.trigger === "pre-update",
    )
  ) {
    throw new SeededDesktopUpgradeSmokeError(
      "The protected update did not retain a verified pre-update backup.",
    );
  }
}

export function assertWebDriverPhaseExit(input: {
  readonly exitCode: number;
  readonly installAttempted: boolean;
  readonly lane: SeededUpgradeLane;
  readonly phase: "seed-and-install" | "verify";
}): void {
  if (input.exitCode === 0) return;
  if (input.phase === "seed-and-install" && input.installAttempted) return;
  throw new SeededDesktopUpgradeSmokeError(
    `The ${input.lane} ${input.phase} WebDriver phase exited with code ${input.exitCode}.`,
  );
}

export async function waitForUpgradeCondition(input: {
  readonly description: string;
  readonly intervalMs: number;
  readonly now?: (() => number) | undefined;
  readonly probe: () => Promise<boolean>;
  readonly sleep?: ((milliseconds: number) => Promise<void>) | undefined;
  readonly timeoutMs: number;
}): Promise<void> {
  const now = input.now ?? Date.now;
  const sleep =
    input.sleep ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  do {
    if (await input.probe()) return;
    await sleep(input.intervalMs);
  } while (now() - startedAt < input.timeoutMs);
  throw new SeededDesktopUpgradeSmokeError(
    `Timed out waiting for ${input.description} after ${input.timeoutMs}ms.`,
  );
}

/** The updater can exit its host before NSIS finishes replacing the installed executable. */
export function windowsCandidateIsInstalled(
  observation: unknown,
  candidateVersion: string,
): boolean {
  if (typeof observation !== "object" || observation === null) return false;
  const value = observation as Record<string, unknown>;
  return (
    value.exists === true &&
    value.productVersion === candidateVersion &&
    typeof value.sha256 === "string" &&
    /^[a-f\d]{64}$/i.test(value.sha256) &&
    Array.isArray(value.installers) &&
    value.installers.length === 0 &&
    value.error === null
  );
}

// Read-only, CI-only evidence. Paths and versions cross as environment values,
// never PowerShell source; process command lines and credentials are not collected.
export const windowsUpgradeObservationScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$observation = [ordered]@{
  observedAtUtc = [System.DateTime]::UtcNow.ToString('o')
  path = $env:BIBCODE_SEEDED_APPLICATION_PATH
  exists = $false
  productVersion = $null
  fileVersion = $null
  sha256 = $null
  installers = @()
  error = $null
}
try {
  $observation.exists = Test-Path -LiteralPath $observation.path -PathType Leaf
  if ($observation.exists) {
    $file = Get-Item -LiteralPath $observation.path
    $observation.productVersion = $file.VersionInfo.ProductVersion
    $observation.fileVersion = $file.VersionInfo.FileVersion
    $observation.sha256 = (Get-FileHash -LiteralPath $observation.path -Algorithm SHA256).Hash
  }
  $suffix = '-' + $env:BIBCODE_SEEDED_CANDIDATE_VERSION + '-installer.exe'
  $observation.installers = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name.EndsWith($suffix, [System.StringComparison]::OrdinalIgnoreCase)
  } | ForEach-Object {
    [ordered]@{ pid = $_.ProcessId; parentPid = $_.ParentProcessId; path = $_.ExecutablePath }
  })
} catch {
  $observation.error = $_.FullyQualifiedErrorId
}
$observation | ConvertTo-Json -Compress -Depth 4
`;

async function waitForWindowsInstalledCandidate(input: {
  readonly appBinaryPath: string;
  readonly candidateVersion: string;
  readonly evidenceDirectory: string;
  readonly timeoutMs: number;
}): Promise<void> {
  await waitForUpgradeCondition({
    description: `Windows candidate ${input.candidateVersion} at the installed application path`,
    intervalMs: 1_000,
    timeoutMs: input.timeoutMs,
    probe: async () => {
      const result = await runBoundedCommand({
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", windowsUpgradeObservationScript],
        cwd: NodePath.dirname(input.appBinaryPath),
        env: {
          ...process.env,
          BIBCODE_SEEDED_APPLICATION_PATH: input.appBinaryPath,
          BIBCODE_SEEDED_CANDIDATE_VERSION: input.candidateVersion,
        },
        timeoutMs: 10_000,
      });
      let observation: unknown;
      try {
        observation = JSON.parse(result.stdout.trim().replace(/^\uFEFF/, ""));
      } catch {
        observation = { error: "Windows version probe returned invalid JSON" };
      }
      await NodeFS.promises.appendFile(
        NodePath.join(input.evidenceDirectory, "windows-install-handoff.log"),
        `${JSON.stringify({ exitCode: result.exitCode, observation })}\n`,
        { mode: 0o600 },
      );
      return (
        result.exitCode === 0 && windowsCandidateIsInstalled(observation, input.candidateVersion)
      );
    },
  });
}

export class ManagedProcessRegistry {
  readonly #entries: Array<{ readonly name: string; readonly cleanup: () => Promise<void> }> = [];
  #cleaned = false;

  add(name: string, cleanup: () => Promise<void>): void {
    if (this.#cleaned) throw new SeededDesktopUpgradeSmokeError("Process cleanup already ran.");
    this.#entries.push({ name, cleanup });
  }

  async cleanup(): Promise<void> {
    if (this.#cleaned) return;
    this.#cleaned = true;
    const failures: string[] = [];
    for (const entry of this.#entries.toReversed()) {
      try {
        await entry.cleanup();
      } catch {
        failures.push(entry.name);
      }
    }
    if (failures.length > 0) {
      throw new SeededDesktopUpgradeSmokeError(
        `Failed to clean managed processes: ${failures.join(", ")}.`,
      );
    }
  }
}

export interface RemoteUploadCapabilityReceipt {
  readonly version: 1;
  readonly relativeDirectory: string;
  readonly relativeUrl: string;
}
const uploadDirectoryPattern =
  /^bibcode-update-witness-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const privateUploadError = () =>
  new SeededDesktopUpgradeSmokeError("The private upload receipt is invalid or unavailable.");
function decodeRemoteUploadReceipt(value: unknown): RemoteUploadCapabilityReceipt {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).sort().join(",") !== "relativeDirectory,relativeUrl,version" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("relativeDirectory" in value) ||
    typeof value.relativeDirectory !== "string" ||
    !uploadDirectoryPattern.test(value.relativeDirectory) ||
    !("relativeUrl" in value) ||
    typeof value.relativeUrl !== "string" ||
    value.relativeUrl.length > 4096 ||
    !/^\/api\/transfers\/[A-Za-z0-9._~-]+$/.test(value.relativeUrl) ||
    new URL(value.relativeUrl, "http://127.0.0.1").pathname !== value.relativeUrl
  ) {
    throw privateUploadError();
  }
  return { version: 1, relativeDirectory: value.relativeDirectory, relativeUrl: value.relativeUrl };
}

async function readBoundedPrivateReceipt(path: string): Promise<unknown | null> {
  try {
    const metadata = await NodeFS.promises.lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw privateUploadError();
    });
    if (metadata === null) return null;
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw privateUploadError();
    const file = await NodeFS.promises.open(path, "r");
    try {
      const bytes = Buffer.alloc(8193);
      let total = 0;
      while (total < bytes.length) {
        const { bytesRead } = await file.read(bytes, total, bytes.length - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > 8192) throw privateUploadError();
      const value: unknown = JSON.parse(bytes.subarray(0, total).toString("utf8"));
      // Only ENOENT is absence. A present JSON null must never permit unredacted retention.
      if (value === null) throw privateUploadError();
      return value;
    } finally {
      await file.close();
    }
  } catch {
    throw privateUploadError();
  }
}

/** Exclusive and flushed before HTTP dispatch; this private record is never an artifact. */
export async function writeRemoteUploadCapabilityReceipt(
  path: string,
  receipt: RemoteUploadCapabilityReceipt,
): Promise<void> {
  try {
    const value = decodeRemoteUploadReceipt(receipt);
    const file = await NodeFS.promises.open(path, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
  } catch {
    throw privateUploadError();
  }
}

/** A malformed private receipt must prevent log retention, not become a raw JSON error. */
export async function readRemoteFixtureSecrets(input: {
  readonly credentialReceiptPath: string;
  readonly uploadReceiptPath: string;
  readonly requireCredentialReceipt?: boolean;
  readonly requireUploadReceipt?: boolean;
}): Promise<string[]> {
  const credentials = await readBoundedPrivateReceipt(input.credentialReceiptPath);
  const upload = await readBoundedPrivateReceipt(input.uploadReceiptPath);
  const secrets: string[] = [];
  if (credentials !== null) {
    if (
      typeof credentials !== "object" ||
      Object.keys(credentials).some((key) => key !== "bootstrapToken" && key !== "endpoint") ||
      !("bootstrapToken" in credentials) ||
      typeof credentials.bootstrapToken !== "string" ||
      credentials.bootstrapToken.length === 0 ||
      credentials.bootstrapToken.length > 6144 ||
      ("endpoint" in credentials && typeof credentials.endpoint !== "string")
    ) {
      throw new SeededDesktopUpgradeSmokeError("The private remote credential receipt is invalid.");
    }
    secrets.push(credentials.bootstrapToken);
  } else if (input.requireCredentialReceipt) {
    throw new SeededDesktopUpgradeSmokeError(
      "The private remote credential receipt is unavailable.",
    );
  }
  if (upload !== null) {
    if (credentials === null) throw privateUploadError();
    const receipt = decodeRemoteUploadReceipt(upload);
    secrets.push(receipt.relativeUrl, receipt.relativeUrl.slice("/api/transfers/".length));
  } else if (input.requireUploadReceipt) throw privateUploadError();
  return secrets;
}

type SeededPhaseIdentity = {
  readonly lane: SeededUpgradeLane;
  readonly phase: "seed-and-install" | "verify";
  readonly trigger: SeededUpgradeTrigger;
};

const readSeededStepStatus = async (path: string, owner: SeededPhaseIdentity) => {
  try {
    const value = await readBoundedPrivateReceipt(path);
    if (value === null) return { availability: "missing", milestone: null } as const;
    if (typeof value === "object" && !Array.isArray(value)) {
      const row = value as Record<string, unknown>;
      const isDeadline = row.milestone === "credential-wide-grant-deadline";
      const grantDeadline = isDeadline ? decodeSeededGrantDeadline(row.grantDeadline) : null;
      const keys = [
        "version",
        "lane",
        "phase",
        "trigger",
        "milestone",
        ...(isDeadline ? ["grantDeadline"] : []),
      ];
      if (
        Object.keys(row).length === keys.length &&
        keys.every((key) => Object.hasOwn(row, key)) &&
        row.version === 1 &&
        row.lane === owner.lane &&
        row.phase === owner.phase &&
        row.trigger === owner.trigger &&
        seededStepMilestones.some((milestone) => milestone === row.milestone) &&
        (!isDeadline || grantDeadline !== null)
      )
        return {
          availability: "valid",
          milestone: row.milestone as (typeof seededStepMilestones)[number],
          ...(isDeadline ? { grantDeadline } : {}),
        } as const;
    }
  } catch {
    // Missing and invalid status are distinct; neither proves a step did not run.
  }
  return { availability: "invalid", milestone: null } as const;
};

const readSeededInstallMarkerState = async (path: string) => {
  try {
    const value = await readBoundedPrivateReceipt(path);
    if (value === null) return "absent";
    if (typeof value !== "object" || Array.isArray(value)) return "unreadable";
    if (!("installAttempted" in value)) return "not-recorded";
    if (value.installAttempted === true) return "recorded";
    if (value.installAttempted === false) return "not-recorded";
  } catch {
    // A malformed or unreadable marker cannot establish dispatch or non-dispatch.
  }
  return "unreadable";
};

const seededReceiptFailureCategory = (error: unknown) => {
  try {
    const message =
      typeof error === "object" && error !== null
        ? Object.getOwnPropertyDescriptor(error, "message")?.value
        : undefined;
    if (message === "The private remote credential receipt is unavailable.")
      return "credential-unavailable";
    if (message === "The private remote credential receipt is invalid.")
      return "credential-invalid";
    if (message === "The private upload receipt is invalid or unavailable.")
      return "private-receipt-invalid-or-unavailable";
  } catch {
    // No accessor, arbitrary message, stack, cause or command output is retained.
  }
  return "validation-failed";
};

/** Independent closed metadata only; this never copies logs or changes receipt admission. */
export async function emitSeededPhaseDiagnostic(
  input: SeededPhaseIdentity & {
    readonly commandOutcome: "returned" | "threw";
    readonly commandExitCode: number | null;
    readonly receiptCheck: "not-checked" | "validated" | "failed";
    readonly receiptError: unknown;
    readonly markerPath: string;
    readonly stepStatusPath: string;
  },
): Promise<void> {
  try {
    const { lane, phase, trigger, commandOutcome, commandExitCode, receiptCheck } = input;
    if (
      !["previous-stable", "protected-baseline", "remote-install"].includes(lane) ||
      !["seed-and-install", "verify"].includes(phase) ||
      !["local-bridge", "remote-rpc"].includes(trigger) ||
      !["returned", "threw"].includes(commandOutcome) ||
      !["not-checked", "validated", "failed"].includes(receiptCheck)
    )
      return;
    const exitCode =
      commandOutcome === "returned" &&
      Number.isSafeInteger(commandExitCode) &&
      commandExitCode !== null &&
      commandExitCode >= -(2 ** 31) &&
      commandExitCode <= 2 ** 32 - 1
        ? commandExitCode
        : null;
    const marker = await readSeededInstallMarkerState(input.markerPath);
    const generatedStep = await readSeededStepStatus(input.stepStatusPath, {
      lane,
      phase,
      trigger,
    });
    console.log(
      JSON.stringify({
        version: 1,
        kind: "seeded-upgrade-phase-diagnostic",
        lane,
        phase,
        trigger,
        command: { outcome: commandOutcome, exitCode },
        receipt:
          receiptCheck === "failed"
            ? seededReceiptFailureCategory(input.receiptError)
            : receiptCheck,
        marker,
        generatedStep,
      }),
    );
  } catch {
    // A diagnostic read/serialization/output failure cannot replace the original failure.
  }
}

/** Run only inside the existing lane process owner, so failed stop cannot unlink a live writer. */
export async function stopRemoteUploadFixture(input: {
  readonly workspaceRoot: string;
  readonly uploadReceiptPath: string;
  readonly stop: () => Promise<void>;
}): Promise<void> {
  await input.stop();
  const value = await readBoundedPrivateReceipt(input.uploadReceiptPath);
  if (value === null) return;
  const receipt = decodeRemoteUploadReceipt(value);
  const directory = NodePath.join(input.workspaceRoot, receipt.relativeDirectory);
  try {
    const metadata = await NodeFS.promises
      .lstat(directory)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw privateUploadError();
      });
    if (metadata === null) return;
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw privateUploadError();
    const names = await NodeFS.promises.readdir(directory);
    if (
      !names.every(
        (name) =>
          name === "protection-witness.txt" ||
          (name.startsWith(".protection-witness.txt.") && name.endsWith(".bibcode-upload.part")),
      )
    ) {
      throw privateUploadError();
    }
    await NodeFS.promises.rm(directory, { recursive: true });
  } catch {
    throw new SeededDesktopUpgradeSmokeError(
      "The stopped upload fixture could not be safely removed.",
    );
  }
}

/** One owned RPC lane; paths and the launch witness cannot be rebound by a later lane. */
export function createRpcUpgradeFixture(input: {
  readonly runRoot: string;
  readonly workspaceRoot: string;
}) {
  const credentialReceiptPath = NodePath.join(input.runRoot, "remote-bootstrap.secret.json");
  const uploadReceiptPath = NodePath.join(input.runRoot, "remote-upload.secret.json");
  const markerPath = NodePath.join(input.runRoot, "before.json");
  const workspaceRoot = input.workspaceRoot;
  let phaseStarted = false;
  return Object.freeze({
    credentialReceiptPath,
    uploadReceiptPath,
    markPhaseStarted: () => {
      phaseStarted = true;
    },
    readSecrets: async () => {
      let installAttempted = false;
      try {
        const marker = await readObservation<{ readonly installAttempted?: unknown }>(markerPath);
        installAttempted = marker.installAttempted === true;
      } catch {
        /* The phase may not have reached its install marker. */
      }
      return readRemoteFixtureSecrets({
        credentialReceiptPath,
        uploadReceiptPath,
        requireCredentialReceipt: phaseStarted,
        requireUploadReceipt: installAttempted,
      });
    },
    stop: async (stop: () => Promise<void>) => {
      await stopRemoteUploadFixture({ workspaceRoot, uploadReceiptPath, stop });
      await NodeFS.promises.rm(uploadReceiptPath, { force: true });
      await NodeFS.promises.rm(credentialReceiptPath, { force: true });
    },
  });
}

type RpcUpgradeFixture = ReturnType<typeof createRpcUpgradeFixture>;

const redactLiteral = (text: string, value: string): string =>
  value.length === 0 ? text : text.split(value).join("[REDACTED]");

// Maintenance labels truncate at160 characters. Exact full-token replacement alone cannot
// protect those prefixes, including their JSON/URI-escaped diagnostic representations.
const signedTransferLabelPattern =
  /(?:\/|\\+\/|\\+u002f|%(?:25)*2f)api(?:\/|\\+\/|\\+u002f|%(?:25)*2f)transfers(?:\/|\\+\/|\\+u002f|%(?:25)*2f)(?:[A-Za-z0-9._~-]|\\+u[0-9a-f]{4}|%[0-9a-f]{2})+(?:…)?/gi;

export function redactAndBoundUpgradeEvidence(
  text: string,
  input: {
    readonly maxBytes: number;
    readonly roots: ReadonlyArray<string>;
    readonly secrets: ReadonlyArray<string>;
  },
): string {
  let redacted = [...input.secrets, ...input.roots]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce(redactLiteral, text.replace(signedTransferLabelPattern, "/api/transfers/[REDACTED]"));
  const encoded = Buffer.from(redacted);
  if (encoded.byteLength <= input.maxBytes) return redacted;
  const suffix = "\n[TRUNCATED]";
  const available = Math.max(0, input.maxBytes - Buffer.byteLength(suffix));
  redacted = encoded
    .subarray(0, available)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
  return `${redacted}${suffix}`.slice(0, input.maxBytes);
}

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export const seededUpgradeVitePlusExecutable = "vp";

const terminateChild = async (child: NodeChildProcess.ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
};

export const runBoundedCommand = async (input: {
  readonly args: ReadonlyArray<string>;
  readonly command: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly inherit?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
  readonly waitForStdioClose?: boolean | undefined;
}): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env ?? process.env,
      shell: false,
      stdio: input.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    let stdout = "";
    let stderr = "";
    let outputTruncated = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      const next = `${stdout}${chunk.toString("utf8")}`;
      outputTruncated ||= next.length > 262_144;
      stdout = next.slice(-262_144);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const next = `${stderr}${chunk.toString("utf8")}`;
      outputTruncated ||= next.length > 262_144;
      stderr = next.slice(-262_144);
    });
    const releaseObservationPipes = () => {
      if (!input.waitForStdioClose) return;
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const timeout =
      input.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (settled) return;
            settled = true;
            releaseObservationPipes();
            void terminateChild(child).then(
              () =>
                reject(
                  new SeededDesktopUpgradeSmokeError(
                    `${NodePath.basename(input.command)} timed out after ${input.timeoutMs}ms.`,
                  ),
                ),
              reject,
            );
          }, input.timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      releaseObservationPipes();
      reject(error);
    });
    // Observers need complete evidence; launchers retain their existing exit-based completion.
    child.once(input.waitForStdioClose ? "close" : "exit", (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (input.waitForStdioClose && outputTruncated) {
        reject(
          new SeededDesktopUpgradeSmokeError("Process observation output exceeded its bound."),
        );
        return;
      }
      // Signal-only termination has no ordinary exit status, including pgrep's no-match code 1.
      resolve({ exitCode: code ?? -1, stderr, stdout });
    });
  });

const runCommand = runBoundedCommand;

export function restartedApplicationCleanupPlan(
  appBinaryPath: string,
  platform: SeededUpgradePlatform,
): { readonly args: ReadonlyArray<string>; readonly command: string } {
  if (platform === "win") {
    return {
      args: ["/F", "/T", "/IM", NodePath.win32.basename(appBinaryPath)],
      command: "taskkill.exe",
    };
  }
  return {
    args: ["-TERM", "-x", "bibcode-desktop"],
    command: "pkill",
  };
}

// Read-only projection of the same process name targeted by the existing CI cleanup plan.
// Names arrive through the environment; no process paths, arguments or error text are returned.
export const windowsApplicationAbsenceScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  if ($env:CI -ne 'true') { throw 'not-ci' }
  $targetName = $env:BIBCODE_SEEDED_APPLICATION_NAME
  if ([string]::IsNullOrWhiteSpace($targetName)) { throw 'missing-target' }
  $records = @(Get-CimInstance -ClassName Win32_Process -Property Name,ProcessId -ErrorAction Stop)
  $matching = 0
  $observedSelf = $false
  foreach ($record in $records) {
    $observedName = [string]$record.Name
    if ([string]::IsNullOrWhiteSpace($observedName)) { throw 'unknown-process' }
    if ($record.ProcessId -eq $PID) { $observedSelf = $true }
    if ([string]::Equals($observedName, $targetName, [System.StringComparison]::OrdinalIgnoreCase)) { $matching += 1 }
  }
  if (-not $observedSelf) { throw 'incomplete-observation' }
  [ordered]@{ observed = $true; matchingProcesses = $matching } | ConvertTo-Json -Compress
} catch {
  '{"observed":false,"matchingProcesses":null}'
  exit 1
}
`;

const restartedApplicationIsAbsent = async (
  appBinaryPath: string,
  platform: SeededUpgradePlatform,
): Promise<boolean> => {
  if (platform === "win") {
    const result = await runCommand({
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", windowsApplicationAbsenceScript],
      cwd: NodePath.dirname(appBinaryPath),
      env: {
        ...process.env,
        BIBCODE_SEEDED_APPLICATION_NAME: NodePath.win32.basename(appBinaryPath),
      },
      timeoutMs: 10_000,
      waitForStdioClose: true,
    });
    if (result.exitCode !== 0 || result.stderr.trim() !== "" || result.stdout.length > 1024)
      throw new Error("Process observation unavailable");
    const value: unknown = JSON.parse(result.stdout.trim().replace(/^\uFEFF/, ""));
    if (
      typeof value !== "object" ||
      value === null ||
      Object.keys(value).sort().join(",") !== "matchingProcesses,observed" ||
      !("observed" in value) ||
      value.observed !== true ||
      !("matchingProcesses" in value) ||
      typeof value.matchingProcesses !== "number" ||
      !Number.isSafeInteger(value.matchingProcesses) ||
      value.matchingProcesses < 0 ||
      value.matchingProcesses > 1_000_000
    )
      throw new Error("Process observation invalid");
    return value.matchingProcesses === 0;
  }
  const result = await runCommand({
    command: "pgrep",
    args: ["-x", "bibcode-desktop"],
    cwd: NodePath.dirname(appBinaryPath),
    timeoutMs: 10_000,
    waitForStdioClose: true,
  });
  if (result.stderr.trim() !== "") throw new Error("Process observation reported an error");
  const pids = result.stdout.trim();
  if (result.exitCode === 1 && pids === "") return true;
  if (result.exitCode === 0 && /^[1-9][0-9]*(?:\r?\n[1-9][0-9]*)*$/.test(pids)) return false;
  throw new Error("Process observation unavailable");
};

const stopRestartedApplication = async (
  appBinaryPath: string,
  platform: SeededUpgradePlatform,
): Promise<void> => {
  if (process.env.CI !== "true") {
    throw new SeededDesktopUpgradeSmokeError(
      "Application cleanup is restricted to the owned CI fixture.",
    );
  }
  const plan = restartedApplicationCleanupPlan(appBinaryPath, platform);
  let confirmedAbsent = 0;
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await restartedApplicationIsAbsent(appBinaryPath, platform)) {
        confirmedAbsent += 1;
        if (confirmedAbsent >= 2) return;
      } else {
        confirmedAbsent = 0;
        // A kill result is never evidence of absence, including a nonzero "not found" exit.
        await runCommand({ ...plan, cwd: NodePath.dirname(appBinaryPath), timeoutMs: 10_000 });
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } catch {
    throw new SeededDesktopUpgradeSmokeError(
      "Application shutdown could not be verified; fixture files were preserved.",
    );
  }
  throw new SeededDesktopUpgradeSmokeError(
    "Application shutdown was not confirmed within its bound; fixture files were preserved.",
  );
};

export async function removeSeededUpgradeDependencyTree(checkout: string): Promise<void> {
  const checkoutRoot = NodePath.resolve(checkout);
  const dependencyTree = NodePath.join(checkoutRoot, "node_modules");
  if (NodePath.relative(checkoutRoot, dependencyTree) !== "node_modules") {
    throw new SeededDesktopUpgradeSmokeError(
      `Refused unsafe seeded-upgrade dependency cleanup: ${dependencyTree}.`,
    );
  }
  await NodeFS.promises.rm(dependencyTree, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
}

const requireCommandSuccess = async (input: Parameters<typeof runCommand>[0]): Promise<void> => {
  const result = await runCommand(input);
  if (result.exitCode !== 0) {
    throw new SeededDesktopUpgradeSmokeError(
      `${NodePath.basename(input.command)} exited with code ${result.exitCode}.`,
    );
  }
};

const writePrivateJson = async (path: string, value: unknown): Promise<void> => {
  await NodeFS.promises.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
};

const recordUpgradeSourceProvenance = async (input: {
  readonly lane: SeededUpgradeLane;
  readonly trigger: SeededUpgradeTrigger;
  readonly checkout: string;
  readonly sourceRef: string;
  readonly baselineVersion: string;
  readonly candidateVersion: string;
  readonly evidenceDirectory: string;
}): Promise<void> => {
  try {
    const head = await runCommand({
      command: "git",
      args: ["rev-parse", "HEAD"],
      cwd: input.checkout,
      timeoutMs: 10000,
    });
    const ref = await runCommand({
      command: "git",
      args: ["rev-parse", `${input.sourceRef}^{commit}`],
      cwd: input.checkout,
      timeoutMs: 10000,
    });
    const sourceCommit = head.stdout.trim();
    if (
      head.exitCode !== 0 ||
      ref.exitCode !== 0 ||
      sourceCommit !== ref.stdout.trim() ||
      !/^[a-f0-9]{40}$/.test(sourceCommit)
    )
      throw new Error("Source identity mismatch");
    const unchanged = await runCommand({
      command: "git",
      args: [
        "diff",
        "--quiet",
        sourceCommit,
        "--",
        ".",
        ...releaseVersionFiles.map((path) => `:(top,exclude,literal)${path}`),
      ],
      cwd: input.checkout,
      timeoutMs: 10000,
    });
    if (unchanged.exitCode !== 0) throw new Error("Baseline source was modified");
    for (const path of releaseVersionFiles) {
      const metadata = await runCommand({
        command: "git",
        args: [
          "diff",
          "--raw",
          "--no-abbrev",
          "--no-renames",
          "-z",
          sourceCommit,
          "--",
          `:(top,literal)${path}`,
        ],
        cwd: input.checkout,
        timeoutMs: 10000,
      });
      if (metadata.exitCode !== 0) throw new Error("Version metadata unavailable");
      if (metadata.stdout !== "") {
        const fields = metadata.stdout.split("\0");
        if (
          fields.length !== 3 ||
          fields[1] !== path ||
          fields[2] !== "" ||
          !/^:100644 100644 [a-f0-9]{40} [a-f0-9]{40} M$/.test(fields[0]!)
        )
          throw new Error("Version file mode or identity changed");
      }
      const object = `${sourceCommit}:${path}`;
      const sizeResult = await runCommand({
        command: "git",
        args: ["cat-file", "-s", object],
        cwd: input.checkout,
        timeoutMs: 10000,
      });
      const size = Number(sizeResult.stdout.trim());
      if (
        sizeResult.exitCode !== 0 ||
        !Number.isSafeInteger(size) ||
        size <= 0 ||
        size > MAX_VERSION_SOURCE_BYTES
      )
        throw new Error("Version source exceeds its bound");
      const original = await runCommand({
        command: "git",
        args: ["show", object],
        cwd: input.checkout,
        timeoutMs: 10000,
      });
      if (original.exitCode !== 0 || Buffer.byteLength(original.stdout) !== size)
        throw new Error("Version source was incomplete");
      const file = NodePath.join(input.checkout, path);
      const stat = await NodeFS.promises.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_VERSION_SOURCE_BYTES)
        throw new Error("Invalid version file");
      assertSeededVersionOverlay(
        path,
        original.stdout,
        await NodeFS.promises.readFile(file, "utf8"),
        input.baselineVersion,
      );
    }
    const sourceHashes: Record<string, string> = {};
    for (const path of UPGRADE_SOURCE_PATHS) {
      sourceHashes[path] = NodeCrypto.createHash("sha256")
        .update(await NodeFS.promises.readFile(NodePath.join(input.checkout, path)))
        .digest("hex");
    }
    const provenance = createSeededUpgradeProvenance({ ...input, sourceCommit, sourceHashes });
    await NodeFS.promises.mkdir(input.evidenceDirectory, { recursive: true, mode: 0o700 });
    await writePrivateJson(
      NodePath.join(input.evidenceDirectory, "source-provenance.json"),
      provenance,
    );
  } catch {
    throw new SeededDesktopUpgradeSmokeError("The unchanged upgrade source could not be verified.");
  }
};

const walkFiles = async (root: string): Promise<ReadonlyArray<string>> => {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await NodeFS.promises.readdir(directory, { withFileTypes: true })) {
      const path = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  await visit(root);
  return files.toSorted();
};

const findExactlyOne = async (
  root: string,
  predicate: (path: string) => boolean,
  description: string,
): Promise<string> => {
  const matches = (await walkFiles(root)).filter(predicate);
  if (matches.length !== 1) {
    throw new SeededDesktopUpgradeSmokeError(
      `Expected exactly one ${description}, found ${matches.length}.`,
    );
  }
  return matches[0]!;
};

export const updaterTargetFor = (
  platform: SeededUpgradePlatform,
  arch: SeededUpgradeArch,
): TauriUpdaterTarget => requireReleaseTarget(platform, arch).updaterTarget;

export const seededUpgradeRustTarget = (
  platform: SeededUpgradePlatform,
  arch: SeededUpgradeArch,
): string => requireReleaseTarget(platform, arch).rustTarget;

const writeBuildOverlay = async (input: {
  readonly createUpdaterArtifacts: boolean;
  readonly endpoint: string;
  readonly identifier: string;
  readonly path: string;
  readonly publicKey: string;
  readonly version: string;
}): Promise<void> => {
  const overlay = buildSeededUpgradeOverlay(input);
  await writePrivateJson(input.path, {
    ...overlay,
    bundle: { createUpdaterArtifacts: input.createUpdaterArtifacts },
  });
};

interface SeededUpgradeBuildVersion {
  readonly checkout: string;
  readonly overlayPath: string;
  readonly version: string;
}

const assertBuildOverlayVersion = async (input: SeededUpgradeBuildVersion): Promise<void> => {
  const overlay = JSON.parse(await NodeFS.promises.readFile(input.overlayPath, "utf8")) as {
    readonly version?: unknown;
  };
  if (overlay.version !== input.version) {
    throw new SeededDesktopUpgradeSmokeError("The seeded-upgrade overlay version does not match.");
  }
};

/** Checks both native metadata and the embedded server's compile-time version. */
export async function assertSeededUpgradeBuildVersion(
  input: SeededUpgradeBuildVersion,
): Promise<void> {
  await assertBuildOverlayVersion(input);
  const assertVersion = (version: unknown, path: string): void => {
    if (version !== input.version) {
      throw new SeededDesktopUpgradeSmokeError(
        `The seeded-upgrade version does not match: ${path}.`,
      );
    }
  };
  for (const path of releasePackageFiles) {
    const metadata = JSON.parse(
      await NodeFS.promises.readFile(NodePath.join(input.checkout, path), "utf8"),
    ) as { readonly version?: unknown };
    assertVersion(metadata.version, path);
  }
  for (const path of releaseRustPackageFiles) {
    const metadata = parseToml(
      await NodeFS.promises.readFile(NodePath.join(input.checkout, path), "utf8"),
    );
    assertVersion((metadata.package as TomlTable | undefined)?.version, path);
  }
  const lock = parseToml(
    await NodeFS.promises.readFile(NodePath.join(input.checkout, releaseCargoLockFile), "utf8"),
  );
  const packages = Array.isArray(lock.package) ? (lock.package as TomlTable[]) : [];
  for (const name of ["bibcode-desktop", "bibcode-server"]) {
    const matches = packages.filter((entry) => entry.name === name);
    if (matches.length !== 1) {
      throw new SeededDesktopUpgradeSmokeError(
        `Expected one seeded-upgrade version in Cargo.lock for ${name}.`,
      );
    }
    assertVersion(matches[0]!.version, `${releaseCargoLockFile}:${name}`);
  }
}

/** Uses the maintained release transaction, never a prior tag's copy or the caller's manifests. */
export async function prepareSeededUpgradeBuild(
  input: SeededUpgradeBuildVersion & { readonly repositoryRoot: string },
): Promise<void> {
  const [checkout, caller] = await Promise.all([
    NodeFS.promises.realpath(input.checkout),
    NodeFS.promises.realpath(input.repositoryRoot),
  ]);
  const nested = (parent: string, child: string): boolean => {
    const relative = NodePath.relative(parent, child);
    return (
      relative === "" ||
      (!relative.startsWith(`..${NodePath.sep}`) &&
        relative !== ".." &&
        !NodePath.isAbsolute(relative))
    );
  };
  if (nested(caller, checkout) || nested(checkout, caller)) {
    throw new SeededDesktopUpgradeSmokeError(
      "Version preparation requires a separate disposable checkout.",
    );
  }
  await assertBuildOverlayVersion(input);
  await requireCommandSuccess({
    command: process.execPath,
    args: [
      NodeURL.fileURLToPath(new URL("./update-release-package-versions.ts", import.meta.url)),
      input.version,
      "--root",
      checkout,
    ],
    cwd: input.repositoryRoot,
    timeoutMs: 30_000,
  });
  await assertSeededUpgradeBuildVersion(input);
}

const buildPackagedApplication = async (input: {
  readonly arch: SeededUpgradeArch;
  readonly bundle: SeededDesktopUpgradeSmokeInput["bundle"];
  readonly checkout: string;
  readonly overlayPath: string;
  readonly platform: SeededUpgradePlatform;
  readonly repositoryRoot: string;
  readonly signingEnvironment: NodeJS.ProcessEnv;
  readonly targetDirectory: string;
  readonly version: string;
}): Promise<void> => {
  await prepareSeededUpgradeBuild(input);
  await requireCommandSuccess({
    command: seededUpgradeVitePlusExecutable,
    args: ["install", "--frozen-lockfile"],
    cwd: input.checkout,
    inherit: true,
    timeoutMs: 10 * 60_000,
  });
  await requireCommandSuccess({
    command: seededUpgradeVitePlusExecutable,
    args: [
      "run",
      "--filter",
      "@bibcode/desktop",
      "build",
      "--features",
      "desktop-e2e",
      "--config",
      NodePath.join(input.checkout, "apps/desktop/src-tauri/tauri.release.conf.json"),
      "--config",
      NodePath.join(input.checkout, "apps/desktop/src-tauri/tauri.e2e.conf.json"),
      "--config",
      input.overlayPath,
      "--bundles",
      input.platform === "mac" ? "app,dmg" : input.bundle,
      "--target",
      seededUpgradeRustTarget(input.platform, input.arch),
    ],
    cwd: input.checkout,
    env: { ...input.signingEnvironment, CARGO_TARGET_DIR: input.targetDirectory },
    inherit: true,
    timeoutMs: 45 * 60_000,
  });
};

export const seededUpgradeBundleRoot = (
  targetDirectory: string,
  platform: SeededUpgradePlatform,
  arch: SeededUpgradeArch,
): string =>
  NodePath.join(targetDirectory, seededUpgradeRustTarget(platform, arch), "release", "bundle");

const baselinePackage = async (
  targetDirectory: string,
  platform: SeededUpgradePlatform,
  arch: SeededUpgradeArch,
): Promise<string> => {
  const suffix = platform === "mac" ? ".dmg" : platform === "linux" ? ".AppImage" : ".exe";
  return findExactlyOne(
    seededUpgradeBundleRoot(targetDirectory, platform, arch),
    (path) => path.endsWith(suffix) && !path.endsWith(`${suffix}.sig`),
    `${platform} baseline package`,
  );
};

const publishCandidateUpdater = async (input: {
  readonly candidateBuildRoot: string;
  readonly candidateVersion: string;
  readonly platform: SeededUpgradePlatform;
  readonly arch: SeededUpgradeArch;
  readonly updaterPort: number;
  readonly updaterRoot: string;
}): Promise<void> => {
  const signaturePath = await findExactlyOne(
    seededUpgradeBundleRoot(input.candidateBuildRoot, input.platform, input.arch),
    (path) => path.endsWith(".sig"),
    "candidate updater signature",
  );
  const payloadPath = signaturePath.slice(0, -".sig".length);
  await NodeFS.promises.access(payloadPath, NodeFS.constants.R_OK);
  const payloadName = NodePath.basename(payloadPath);
  const signatureName = NodePath.basename(signaturePath);
  await NodeFS.promises.copyFile(payloadPath, NodePath.join(input.updaterRoot, payloadName));
  await NodeFS.promises.copyFile(signaturePath, NodePath.join(input.updaterRoot, signatureName));
  const manifest = buildLocalUpdaterManifest({
    artifact: payloadName,
    baseUrl: `http://${MOCK_UPDATE_LOOPBACK_HOST}:${input.updaterPort}/`,
    candidateVersion: input.candidateVersion,
    signature: await NodeFS.promises.readFile(signaturePath, "utf8"),
    target: updaterTargetFor(input.platform, input.arch),
  });
  await writePrivateJson(NodePath.join(input.updaterRoot, "latest.json"), manifest);
};

const copyMacApplication = async (dmgPath: string, installRoot: string): Promise<string> => {
  const mount = NodePath.join(installRoot, "mount");
  const application = NodePath.join(installRoot, "BiBCode.app");
  await NodeFS.promises.mkdir(mount, { recursive: true });
  await requireCommandSuccess({
    command: "hdiutil",
    args: ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, dmgPath],
    cwd: installRoot,
    timeoutMs: 120_000,
  });
  try {
    const source = await findExactlyOne(
      mount,
      (path) => path.endsWith(".app/Contents/MacOS/bibcode-desktop"),
      "mounted BiBCode executable",
    );
    const sourceApplication = source.slice(0, source.indexOf(".app") + ".app".length);
    await NodeFS.promises.cp(sourceApplication, application, { recursive: true });
  } finally {
    await requireCommandSuccess({
      command: "hdiutil",
      args: ["detach", mount],
      cwd: installRoot,
      timeoutMs: 120_000,
    });
  }
  return NodePath.join(application, "Contents", "MacOS", "bibcode-desktop");
};

const installBaselinePackage = async (input: {
  readonly laneRoot: string;
  readonly packagePath: string;
  readonly platform: SeededUpgradePlatform;
}): Promise<string> => {
  const installRoot = NodePath.join(input.laneRoot, "installed");
  await NodeFS.promises.mkdir(installRoot, { recursive: true });
  if (input.platform === "mac") return copyMacApplication(input.packagePath, installRoot);
  if (input.platform === "linux") {
    const application = NodePath.join(installRoot, "BiBCode.AppImage");
    await NodeFS.promises.copyFile(input.packagePath, application);
    await NodeFS.promises.chmod(application, 0o700);
    return application;
  }
  await requireCommandSuccess({
    command: input.packagePath,
    args: ["/S", `/D=${installRoot}`],
    cwd: installRoot,
    timeoutMs: 180_000,
  });
  return findExactlyOne(
    installRoot,
    (path) => /(?:BiBCode|bibcode-desktop)\.exe$/i.test(path),
    "NSIS-installed BiBCode executable",
  );
};

export const createSeededUpgradeWdioConfig = (input: {
  readonly appBinaryPath: string;
  readonly artifactDirectory: string;
  readonly restartTimeoutMs: number;
  readonly specPath: string;
  readonly webdriverPort: number;
  readonly testTimeoutMs?: number;
}): string => `
export const config = {
  runner: "local",
  specs: [${JSON.stringify(input.specPath)}],
  maxInstances: 1,
  services: [["@wdio/tauri-service", {
    appBinaryPath: ${JSON.stringify(input.appBinaryPath)},
    driverProvider: "embedded",
    embeddedPort: ${input.webdriverPort},
    startTimeout: ${input.restartTimeoutMs},
    statusPollTimeout: 10000,
    commandTimeout: 30000,
    captureBackendLogs: true,
    logDir: ${JSON.stringify(input.artifactDirectory)},
  }]],
  capabilities: [{ browserName: "tauri", "tauri:options": { application: ${JSON.stringify(input.appBinaryPath)} } }],
  logLevel: "info",
  outputDir: ${JSON.stringify(input.artifactDirectory)},
  bail: 1,
  waitforTimeout: 20000,
  connectionRetryTimeout: ${input.restartTimeoutMs},
  connectionRetryCount: 0,
  framework: "mocha",
  reporters: ["spec"],
  transformRequest: (request) => {
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    return { ...request, headers };
  },
  mochaOpts: { ui: "bdd", timeout: ${input.testTimeoutMs ?? Math.max(input.restartTimeoutMs, 120_000)} },
};
`;

const runWebDriverPhase = async (input: {
  readonly appBinaryPath: string;
  readonly backendPort: number;
  readonly candidateVersion: string;
  readonly baselineVersion?: string | undefined;
  readonly dataRoot: string;
  readonly evidenceDirectory: string;
  readonly expectedDataRoot: string;
  readonly lane: SeededUpgradeLane;
  readonly trigger: SeededUpgradeTrigger;
  readonly rpcFixture?: RpcUpgradeFixture | undefined;
  readonly phase: "seed-and-install" | "verify";
  readonly platform: SeededUpgradePlatform;
  readonly projectId: string;
  readonly repositoryRoot: string;
  readonly restartTimeoutMs: number;
  readonly resultPath: string;
  readonly runRoot: string;
  readonly workspaceRoot: string;
  readonly webdriverPort: number;
  readonly wsl: boolean;
}): Promise<void> => {
  const { rpcFixture, ...driverInput } = input;
  if ((input.trigger === "remote-rpc") !== (rpcFixture !== undefined)) {
    throw new SeededDesktopUpgradeSmokeError("The RPC phase requires its own fixture owner.");
  }
  const phaseRoot = NodePath.join(input.runRoot, `${input.phase}-driver`);
  await NodeFS.promises.mkdir(phaseRoot, { recursive: true });
  const specPath = NodePath.join(phaseRoot, "seeded-upgrade.e2e.ts");
  const configPath = NodePath.join(phaseRoot, "wdio.conf.mjs");
  const stepStatusPath = NodePath.join(phaseRoot, "step-status.private.json");
  const phaseTimeoutMs =
    input.trigger === "remote-rpc" && input.phase === "seed-and-install"
      ? input.restartTimeoutMs +
        REMOTE_UPDATE_DOWNLOAD_BUDGET_MS +
        REMOTE_UPDATE_INSTALL_BUDGET_MS +
        REMOTE_UPDATE_RESTART_BUDGET_MS +
        90_000
      : input.restartTimeoutMs + (input.phase === "seed-and-install" ? 90_000 : 30_000);
  await NodeFS.promises.writeFile(
    specPath,
    createSeededUpgradeDriverSpec({
      ...driverInput,
      ...(rpcFixture !== undefined
        ? {
            stepStatusPath,
            remoteInstallDriverPath: NodeURL.pathToFileURL(
              NodePath.join(input.repositoryRoot, "scripts/lib/remote-install-driver.ts"),
            ).href,
            remoteHarnessPath: NodeURL.pathToFileURL(
              NodePath.join(input.repositoryRoot, "scripts/seeded-desktop-upgrade-smoke.ts"),
            ).href,
            remoteSecretPath: rpcFixture.credentialReceiptPath,
            remoteUploadSecretPath: rpcFixture.uploadReceiptPath,
            remoteEvidencePath: NodePath.join(input.evidenceDirectory, "remote-rpc.json"),
          }
        : {}),
    }),
    { mode: 0o600 },
  );
  await NodeFS.promises.writeFile(
    configPath,
    createSeededUpgradeWdioConfig({
      appBinaryPath: input.appBinaryPath,
      artifactDirectory: input.evidenceDirectory,
      restartTimeoutMs: input.restartTimeoutMs,
      specPath,
      webdriverPort: input.webdriverPort,
      testTimeoutMs: phaseTimeoutMs,
    }),
    { mode: 0o600 },
  );
  // Once launch is attempted, even a failed phase may have returned a grant to WDIO output.
  // Notify before dispatch; local spec/config preparation failures require no credential receipt.
  rpcFixture?.markPhaseStarted();
  let commandOutcome: "returned" | "threw" = "threw";
  let commandExitCode: number | null = null;
  let receiptCheck: "not-checked" | "validated" | "failed" = "not-checked";
  try {
    const result = await runCommand({
      command: seededUpgradeVitePlusExecutable,
      args: ["exec", "wdio", "run", configPath],
      cwd: NodePath.join(input.repositoryRoot, "apps", "desktop"),
      env: {
        ...process.env,
        BIBCODE_HOME: input.dataRoot,
        BIBCODE_PORT: String(input.backendPort),
        BIBCODE_E2E_PLATFORM: input.platform,
        RUST_LOG: "bibcode=debug",
        ...(input.wsl
          ? {
              WSLENV: [process.env.WSLENV, "BIBCODE_HOME/p"].filter(Boolean).join(":"),
            }
          : {}),
      },
      timeoutMs: phaseTimeoutMs,
    });
    commandOutcome = "returned";
    commandExitCode = result.exitCode;
    const resultExists = NodeFS.existsSync(input.resultPath);
    let installAttempted = false;
    if (input.phase === "seed-and-install" && resultExists) {
      try {
        const marker = JSON.parse(await NodeFS.promises.readFile(input.resultPath, "utf8")) as {
          readonly installAttempted?: unknown;
        };
        installAttempted = marker.installAttempted === true;
      } catch {
        installAttempted = false;
      }
    }
    receiptCheck = rpcFixture !== undefined ? "failed" : "not-checked";
    const privateSecrets = rpcFixture !== undefined ? await rpcFixture.readSecrets() : [];
    if (rpcFixture !== undefined) receiptCheck = "validated";
    await NodeFS.promises.writeFile(
      NodePath.join(input.evidenceDirectory, `${input.phase}.log`),
      redactAndBoundUpgradeEvidence(`${result.stdout}\n${result.stderr}`, {
        maxBytes: 64 * 1024,
        roots: [input.dataRoot, input.runRoot],
        secrets: privateSecrets,
      }),
    );
    assertWebDriverPhaseExit({
      exitCode: result.exitCode,
      installAttempted,
      lane: input.lane,
      phase: input.phase,
    });
  } catch (failure) {
    if (rpcFixture !== undefined) {
      try {
        await emitSeededPhaseDiagnostic({
          lane: input.lane,
          phase: input.phase,
          trigger: input.trigger,
          commandOutcome,
          commandExitCode,
          receiptCheck,
          receiptError: failure,
          markerPath: NodePath.join(input.runRoot, "before.json"),
          stepStatusPath,
        });
      } catch {
        // Even an unavailable diagnostic dependency must not change failure or cleanup.
      }
    }
    throw failure;
  }
};

const startMockUpdateServer = async (input: {
  readonly port: number;
  readonly repositoryRoot: string;
  readonly requestLogPath: string;
  readonly updaterRoot: string;
}): Promise<NodeChildProcess.ChildProcess> => {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [NodePath.join(input.repositoryRoot, "scripts/mock-update-server.ts")],
    {
      cwd: input.repositoryRoot,
      env: {
        ...process.env,
        BIBCODE_DESKTOP_MOCK_UPDATE_SERVER_PORT: String(input.port),
        BIBCODE_DESKTOP_MOCK_UPDATE_SERVER_REQUEST_LOG: input.requestLogPath,
        BIBCODE_DESKTOP_MOCK_UPDATE_SERVER_ROOT: input.updaterRoot,
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  );
  let startupError: Error | undefined;
  child.once("error", (error) => {
    startupError = error;
  });
  try {
    await waitForUpgradeCondition({
      description: "local test updater readiness",
      intervalMs: 100,
      probe: async () => {
        if (startupError !== undefined) throw startupError;
        try {
          const response = await fetch(
            `http://${MOCK_UPDATE_LOOPBACK_HOST}:${input.port}${MOCK_UPDATE_READY_PATH}`,
          );
          return response.ok;
        } catch {
          return false;
        }
      },
      timeoutMs: MOCK_UPDATE_READY_TIMEOUT_MS,
    });
    return child;
  } catch (error) {
    await terminateChild(child);
    throw error;
  }
};

const readObservation = async <A>(path: string): Promise<A> =>
  JSON.parse(await NodeFS.promises.readFile(path, "utf8")) as A;

const linuxLaneProcesses = async (): Promise<
  ReadonlyArray<{ pid: number; comm: string; environ: string }>
> => {
  const processes: Array<{ pid: number; comm: string; environ: string }> = [];
  for (const entry of await NodeFS.promises.readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      processes.push({
        pid: Number(entry),
        comm: (await NodeFS.promises.readFile(`/proc/${entry}/comm`, "utf8")).trim(),
        environ: await NodeFS.promises.readFile(`/proc/${entry}/environ`, "utf8"),
      });
    } catch {
      /* Exited or unreadable processes do not establish lane ownership. */
    }
  }
  return processes;
};
/** Sample while the updater-restarted host is still live, before WebDriver teardown. */
export async function captureRemoteInstallHostEvidence(input: {
  readonly dataRoot: string;
  readonly appBinaryPath: string;
  readonly platform: SeededUpgradePlatform;
}) {
  const log = await NodeFS.promises.readFile(
    NodePath.join(input.dataRoot, "userdata", "logs", "server.log"),
    "utf8",
  );
  const processes = input.platform === "linux" ? await linuxLaneProcesses() : null;
  const prefix = `.mount_${NodePath.basename(input.appBinaryPath).slice(0, 6)}`;
  return {
    requesterLogLines: log
      .split("\n")
      .filter((line) => line.includes("remote update install requested")).length,
    appImageMounts:
      input.platform === "linux"
        ? countAppImageMounts(await NodeFS.promises.readFile("/proc/mounts", "utf8"), prefix)
        : null,
    runtimeProcesses:
      processes === null
        ? null
        : processes.filter(
            (entry) =>
              scopedCleanupPids([entry], input.dataRoot).length === 1 &&
              entry.comm === NodePath.basename(input.appBinaryPath).slice(0, 15),
          ).length,
  };
}
const stopRemoteLaneApplication = async (
  appBinaryPath: string,
  platform: SeededUpgradePlatform,
  dataRoot: string,
): Promise<void> => {
  if (platform !== "linux") {
    await stopRestartedApplication(appBinaryPath, platform);
    return;
  }
  for (const pid of scopedCleanupPids(await linuxLaneProcesses(), dataRoot)) {
    try {
      const environment = await NodeFS.promises.readFile(`/proc/${pid}/environ`, "utf8");
      if (!environment.split("\0").includes(`BIBCODE_HOME=${dataRoot}`)) continue;
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (!["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  await waitForUpgradeCondition({
    description: "isolated remote application shutdown",
    intervalMs: 100,
    timeoutMs: 30_000,
    probe: async () => scopedCleanupPids(await linuxLaneProcesses(), dataRoot).length === 0,
  });
};

const runUpgradeLane = async (input: {
  readonly appBinaryPath: string;
  readonly backendPort: number;
  readonly candidateVersion: string;
  readonly baselineVersion?: string | undefined;
  readonly layout: SeededUpgradeLaneLayout;
  readonly lane: SeededUpgradeLane;
  readonly trigger: SeededUpgradeTrigger;
  readonly rpcFixture?: RpcUpgradeFixture | undefined;
  readonly platform: SeededUpgradePlatform;
  readonly projectId: string;
  readonly repositoryRoot: string;
  readonly restartTimeoutMs: number;
  readonly webdriverPort: number;
  readonly wsl: boolean;
}): Promise<void> => {
  await NodeFS.promises.mkdir(input.layout.dataRoot, { recursive: true, mode: 0o700 });
  await NodeFS.promises.mkdir(input.layout.evidenceDirectory, { recursive: true, mode: 0o700 });
  await NodeFS.promises.mkdir(input.layout.workspaceRoot, { recursive: true, mode: 0o700 });
  const beforePath = NodePath.join(NodePath.dirname(input.layout.dataRoot), "before.json");
  const afterPath = NodePath.join(NodePath.dirname(input.layout.dataRoot), "after.json");
  const shared = {
    appBinaryPath: input.appBinaryPath,
    backendPort: input.backendPort,
    candidateVersion: input.candidateVersion,
    baselineVersion: input.baselineVersion,
    dataRoot: input.layout.dataRoot,
    evidenceDirectory: input.layout.evidenceDirectory,
    expectedDataRoot: input.layout.dataRoot,
    lane: input.lane,
    trigger: input.trigger,
    rpcFixture: input.rpcFixture,
    platform: input.platform,
    projectId: input.projectId,
    repositoryRoot: input.repositoryRoot,
    restartTimeoutMs: input.restartTimeoutMs,
    runRoot: NodePath.dirname(input.layout.dataRoot),
    workspaceRoot: input.wsl
      ? `/tmp/bibcode-seeded-upgrade-${input.projectId.replaceAll(/[^A-Za-z0-9._-]/g, "-")}`
      : input.layout.workspaceRoot,
    webdriverPort: input.webdriverPort,
    wsl: input.wsl,
  } as const;
  await runWebDriverPhase({ ...shared, phase: "seed-and-install", resultPath: beforePath });
  if (input.platform === "win") {
    await waitForWindowsInstalledCandidate({
      appBinaryPath: input.appBinaryPath,
      candidateVersion: input.candidateVersion,
      evidenceDirectory: input.layout.evidenceDirectory,
      timeoutMs: input.restartTimeoutMs,
    });
  }
  if (input.trigger === "remote-rpc") {
    const remote = await readObservation<
      Omit<RemoteInstallEvidence, "preUpdateBackups"> & { widened: boolean }
    >(NodePath.join(input.layout.evidenceDirectory, "remote-rpc.json"));
    await writePrivateJson(
      NodePath.join(input.layout.evidenceDirectory, "remote-host.json"),
      remote,
    );
    await stopRemoteLaneApplication(input.appBinaryPath, input.platform, input.layout.dataRoot);
  } else await stopRestartedApplication(input.appBinaryPath, input.platform);
  await runWebDriverPhase({ ...shared, phase: "verify", resultPath: afterPath });
  const before = await readObservation<SeededUpgradeObservationBefore>(beforePath);
  const after = await readObservation<SeededUpgradeObservationAfter>(afterPath);
  if (input.baselineVersion !== undefined && before.appVersion !== input.baselineVersion) {
    throw new SeededDesktopUpgradeSmokeError(
      "The starting app version did not match the planned baseline.",
    );
  }
  verifySeededUpgradeOutcome(input.lane, before, after, input.candidateVersion, input.trigger);
  if (input.trigger === "remote-rpc") {
    const remote = await readObservation<Omit<RemoteInstallEvidence, "preUpdateBackups">>(
      NodePath.join(input.layout.evidenceDirectory, "remote-host.json"),
    );
    const evidence: RemoteInstallEvidence = {
      ...remote,
      preUpdateBackups: after.preUpdateBackups.filter(
        (backup) =>
          backup.trigger === "pre-update" && backup.storageInstanceId === before.storageInstanceId,
      ).length,
    };
    verifyRemoteInstallOutcome(evidence, input.candidateVersion);
    if (
      evidence.before.storageInstanceId !== before.storageInstanceId ||
      evidence.after.storageInstanceId !== after.storageInstanceId ||
      evidence.before.serverVersion !== before.appVersion
    ) {
      throw new SeededDesktopUpgradeSmokeError(
        "The RPC update observations did not match the seeded host identity.",
      );
    }
    await writePrivateJson(
      NodePath.join(input.layout.evidenceDirectory, "remote-install-result.json"),
      evidence,
    );
  }
  await NodeFS.promises.writeFile(
    NodePath.join(input.layout.evidenceDirectory, "result.json"),
    `${JSON.stringify({
      lane: input.lane,
      trigger: input.trigger,
      coverageStatus: "verified",
      ...(input.baselineVersion !== undefined
        ? {
            plannedBaselineVersion: input.baselineVersion,
            observedBaselineVersion: before.appVersion,
          }
        : {}),
      candidateVersion: input.candidateVersion,
      observedAppVersion: after.appVersion,
      projectRetained: true,
      storageIdentityRetained:
        before.storageInstanceId === null || before.storageInstanceId === after.storageInstanceId,
      preUpdateBackupObserved:
        (input.lane === "previous-stable" && input.trigger === "local-bridge") ||
        after.preUpdateBackups.some(
          (backup) =>
            backup.trigger === "pre-update" &&
            backup.storageInstanceId === before.storageInstanceId,
        ),
    })}\n`,
  );
};

const copyBoundedEvidence = async (input: {
  readonly artifactDirectory: string;
  readonly layout: SeededUpgradeRunLayout;
  readonly requestLogPath: string;
  readonly secrets: ReadonlyArray<string>;
}): Promise<void> => {
  await NodeFS.promises.mkdir(input.artifactDirectory, { recursive: true });
  const lanes = [
    ["previous-stable", input.layout.previousStable],
    ["protected-baseline", input.layout.protectedBaseline],
    ["remote-install", input.layout.remoteInstall],
  ] as const;
  for (const [lane, layout] of lanes) {
    if (!NodeFS.existsSync(layout.evidenceDirectory)) continue;
    for (const source of await walkFiles(layout.evidenceDirectory)) {
      if (!/\.(?:json|log|txt)$/i.test(source)) continue;
      const bounded = redactAndBoundUpgradeEvidence(
        await NodeFS.promises.readFile(source, "utf8"),
        {
          maxBytes: 64 * 1024,
          roots: [layout.dataRoot, layout.workspaceRoot, layout.checkout],
          secrets: input.secrets,
        },
      );
      await NodeFS.promises.writeFile(
        NodePath.join(input.artifactDirectory, `${lane}-${NodePath.basename(source)}`),
        bounded,
      );
    }
    if (NodeFS.existsSync(layout.dataRoot)) {
      const tree = (await walkFiles(layout.dataRoot))
        .map((path) => NodePath.relative(layout.dataRoot, path))
        .slice(0, 1_000)
        .join("\n");
      await NodeFS.promises.writeFile(
        NodePath.join(input.artifactDirectory, `${lane}-root-tree.txt`),
        redactAndBoundUpgradeEvidence(tree, {
          maxBytes: 32 * 1024,
          roots: [layout.dataRoot],
          secrets: input.secrets,
        }),
      );
    }
  }
  if (NodeFS.existsSync(input.requestLogPath)) {
    await NodeFS.promises.writeFile(
      NodePath.join(input.artifactDirectory, "updater-requests.jsonl"),
      redactAndBoundUpgradeEvidence(await NodeFS.promises.readFile(input.requestLogPath, "utf8"), {
        maxBytes: 64 * 1024,
        roots: [],
        secrets: input.secrets,
      }),
    );
  }
};

export async function runSeededDesktopUpgradeSmoke(
  input: SeededDesktopUpgradeSmokeInput,
): Promise<void> {
  if (process.env.CI !== "true")
    throw new SeededDesktopUpgradeSmokeError(
      "This packaged-upgrade harness is CI-only; it can terminate desktop applications.",
    );
  const previousTrigger = previousStableTrigger(
    input.previousStableTrigger,
    input.platform,
    input.wsl,
  );
  const baselineVersion = previousTrigger === "remote-rpc" ? input.previousVersion : undefined;
  assertBaselineVersionIsOlder(input.previousVersion, input.candidateVersion);
  const runId = input.runId;
  const workRoot = await canonicalizeSeededUpgradeWorkRoot(input.workRoot);
  const layout = createSeededUpgradeRunLayout(workRoot, runId);
  const runRoot = NodePath.dirname(layout.updaterRoot);
  const appIdentifier = `dev.bibcode.upgradesmoke.run-${runId
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, "-")
    .slice(0, 80)}`;
  const relativeToRepository = NodePath.relative(input.repositoryRoot, runRoot);
  if (
    relativeToRepository === "" ||
    (!relativeToRepository.startsWith("..") && !NodePath.isAbsolute(relativeToRepository))
  ) {
    throw new SeededDesktopUpgradeSmokeError(
      "The seeded-upgrade work root must be outside the repository checkout.",
    );
  }

  const signingKey = process.env.TAURI_SIGNING_PRIVATE_KEY?.trim();
  const signingPassword = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD?.trim();
  if (!signingKey || !signingPassword) {
    throw new SeededDesktopUpgradeSmokeError(
      "The seeded packaged-upgrade smoke requires ephemeral Tauri signing credentials.",
    );
  }
  const publicKey = (await NodeFS.promises.readFile(input.publicKeyFile, "utf8")).trim();
  if (publicKey.length === 0) {
    throw new SeededDesktopUpgradeSmokeError("The generated Tauri updater public key is empty.");
  }

  await NodeFS.promises.mkdir(runRoot, { mode: 0o700 });
  await NodeFS.promises.mkdir(layout.updaterRoot, { mode: 0o700 });
  await NodeFS.promises.mkdir(NodePath.dirname(layout.previousStable.checkout), {
    recursive: true,
    mode: 0o700,
  });
  await NodeFS.promises.mkdir(NodePath.dirname(layout.protectedBaseline.checkout), {
    recursive: true,
    mode: 0o700,
  });

  const endpoint = `http://${MOCK_UPDATE_LOOPBACK_HOST}:${input.updaterPort}/latest.json`;
  const candidateOverlay = NodePath.join(runRoot, "candidate-overlay.json");
  const previousOverlay = NodePath.join(runRoot, "previous-overlay.json");
  const protectedOverlay = NodePath.join(runRoot, "protected-overlay.json");
  await writeBuildOverlay({
    createUpdaterArtifacts: true,
    endpoint,
    identifier: appIdentifier,
    path: candidateOverlay,
    publicKey,
    version: input.candidateVersion,
  });
  await writeBuildOverlay({
    createUpdaterArtifacts: false,
    endpoint,
    identifier: appIdentifier,
    path: previousOverlay,
    publicKey,
    version: input.previousVersion,
  });
  await writeBuildOverlay({
    createUpdaterArtifacts: false,
    endpoint,
    identifier: appIdentifier,
    path: protectedOverlay,
    publicKey,
    version: input.previousVersion,
  });

  const cleanup = new ManagedProcessRegistry();
  const rpcFixtures: RpcUpgradeFixture[] = [];
  const signingEnvironment = {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: signingKey,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: signingPassword,
    VITE_BIBCODE_DESKTOP_E2E: "1",
  };
  const requestLogPath = NodePath.join(runRoot, "updater-requests.jsonl");
  let failure: unknown;
  try {
    if (!input.wsl) {
      await requireCommandSuccess({
        command: "git",
        args: ["worktree", "add", "--detach", layout.previousStable.checkout, input.previousTag],
        cwd: input.repositoryRoot,
        timeoutMs: 120_000,
      });
      cleanup.add("previous stable checkout", async () => {
        await removeSeededUpgradeDependencyTree(layout.previousStable.checkout);
        await requireCommandSuccess({
          command: "git",
          args: ["worktree", "remove", "--force", layout.previousStable.checkout],
          cwd: input.repositoryRoot,
          timeoutMs: 120_000,
        });
      });
    }
    const currentCommit = (
      await runCommand({
        command: "git",
        args: ["rev-parse", "HEAD"],
        cwd: input.repositoryRoot,
        timeoutMs: 30_000,
      })
    ).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(currentCommit)) {
      throw new SeededDesktopUpgradeSmokeError("Could not resolve the candidate commit.");
    }
    await requireCommandSuccess({
      command: "git",
      args: ["worktree", "add", "--detach", layout.protectedBaseline.checkout, currentCommit],
      cwd: input.repositoryRoot,
      timeoutMs: 120_000,
    });
    cleanup.add("protected baseline checkout", async () => {
      await removeSeededUpgradeDependencyTree(layout.protectedBaseline.checkout);
      await requireCommandSuccess({
        command: "git",
        args: ["worktree", "remove", "--force", layout.protectedBaseline.checkout],
        cwd: input.repositoryRoot,
        timeoutMs: 120_000,
      });
    });
    await requireCommandSuccess({
      command: "git",
      args: ["worktree", "add", "--detach", layout.candidateCheckout, currentCommit],
      cwd: input.repositoryRoot,
      timeoutMs: 120_000,
    });
    cleanup.add("candidate checkout", async () => {
      await removeSeededUpgradeDependencyTree(layout.candidateCheckout);
      await requireCommandSuccess({
        command: "git",
        args: ["worktree", "remove", "--force", layout.candidateCheckout],
        cwd: input.repositoryRoot,
        timeoutMs: 120_000,
      });
    });

    await buildPackagedApplication({
      arch: input.arch,
      bundle: input.bundle,
      checkout: layout.candidateCheckout,
      overlayPath: candidateOverlay,
      platform: input.platform,
      repositoryRoot: input.repositoryRoot,
      signingEnvironment,
      targetDirectory: layout.candidateBuildRoot,
      version: input.candidateVersion,
    });
    if (!input.wsl) {
      await buildPackagedApplication({
        arch: input.arch,
        bundle: input.bundle,
        checkout: layout.previousStable.checkout,
        overlayPath: previousOverlay,
        platform: input.platform,
        repositoryRoot: input.repositoryRoot,
        signingEnvironment,
        targetDirectory: layout.previousStable.buildRoot,
        version: input.previousVersion,
      });
    }
    await buildPackagedApplication({
      arch: input.arch,
      bundle: input.bundle,
      checkout: layout.protectedBaseline.checkout,
      overlayPath: protectedOverlay,
      platform: input.platform,
      repositoryRoot: input.repositoryRoot,
      signingEnvironment,
      targetDirectory: layout.protectedBaseline.buildRoot,
      version: input.previousVersion,
    });
    if (previousTrigger === "remote-rpc") {
      for (const [lane, trigger, sourceRef, sourceLayout, resultLayout] of [
        [
          "previous-stable",
          "remote-rpc",
          input.previousTag,
          layout.previousStable,
          layout.previousStable,
        ],
        [
          "protected-baseline",
          "local-bridge",
          currentCommit,
          layout.protectedBaseline,
          layout.protectedBaseline,
        ],
        [
          "remote-install",
          "remote-rpc",
          currentCommit,
          layout.protectedBaseline,
          layout.remoteInstall,
        ],
      ] as const) {
        await recordUpgradeSourceProvenance({
          lane,
          trigger,
          sourceRef,
          checkout: sourceLayout.checkout,
          baselineVersion: input.previousVersion,
          candidateVersion: input.candidateVersion,
          evidenceDirectory: resultLayout.evidenceDirectory,
        });
      }
    }
    await publishCandidateUpdater({
      arch: input.arch,
      candidateBuildRoot: layout.candidateBuildRoot,
      candidateVersion: input.candidateVersion,
      platform: input.platform,
      updaterPort: input.updaterPort,
      updaterRoot: layout.updaterRoot,
    });

    const updater = await startMockUpdateServer({
      port: input.updaterPort,
      repositoryRoot: input.repositoryRoot,
      requestLogPath,
      updaterRoot: layout.updaterRoot,
    });
    cleanup.add("local test updater", () => terminateChild(updater));

    if (!input.wsl) {
      const previousPackage = await baselinePackage(
        layout.previousStable.buildRoot,
        input.platform,
        input.arch,
      );
      const previousApp = await installBaselinePackage({
        laneRoot: NodePath.dirname(layout.previousStable.dataRoot),
        packagePath: previousPackage,
        platform: input.platform,
      });
      const previousRpc =
        previousTrigger === "remote-rpc"
          ? createRpcUpgradeFixture({
              runRoot: NodePath.dirname(layout.previousStable.dataRoot),
              workspaceRoot: layout.previousStable.workspaceRoot,
            })
          : undefined;
      if (previousRpc !== undefined) {
        rpcFixtures.push(previousRpc);
        cleanup.add("previous RPC application", () =>
          previousRpc.stop(() =>
            stopRemoteLaneApplication(previousApp, input.platform, layout.previousStable.dataRoot),
          ),
        );
      }
      await runUpgradeLane({
        appBinaryPath: previousApp,
        backendPort: input.updaterPort + 1,
        candidateVersion: input.candidateVersion,
        lane: "previous-stable",
        baselineVersion,
        trigger: previousTrigger,
        rpcFixture: previousRpc,
        layout: layout.previousStable,
        platform: input.platform,
        projectId: `seed-${runId}-previous`,
        repositoryRoot: input.repositoryRoot,
        restartTimeoutMs: input.restartTimeoutMs,
        webdriverPort: input.updaterPort + 101,
        wsl: false,
      });
    }

    const protectedPackage = await baselinePackage(
      layout.protectedBaseline.buildRoot,
      input.platform,
      input.arch,
    );
    const protectedApp = await installBaselinePackage({
      laneRoot: NodePath.dirname(layout.protectedBaseline.dataRoot),
      packagePath: protectedPackage,
      platform: input.platform,
    });
    await runUpgradeLane({
      appBinaryPath: protectedApp,
      backendPort: input.updaterPort + 2,
      candidateVersion: input.candidateVersion,
      lane: "protected-baseline",
      baselineVersion,
      trigger: "local-bridge",
      layout: layout.protectedBaseline,
      platform: input.platform,
      projectId: `seed-${runId}-protected`,
      repositoryRoot: input.repositoryRoot,
      restartTimeoutMs: input.restartTimeoutMs,
      webdriverPort: input.updaterPort + 102,
      wsl: input.wsl,
    });
    if (!input.wsl) {
      let remoteApp = await installBaselinePackage({
        laneRoot: NodePath.dirname(layout.remoteInstall.dataRoot),
        packagePath: protectedPackage,
        platform: input.platform,
      });
      if (input.platform === "linux") {
        const isolatedAppImage = NodePath.join(NodePath.dirname(remoteApp), "RemoteLane.AppImage");
        await NodeFS.promises.rename(remoteApp, isolatedAppImage);
        remoteApp = isolatedAppImage;
      }
      const remoteRpc = createRpcUpgradeFixture({
        runRoot: NodePath.dirname(layout.remoteInstall.dataRoot),
        workspaceRoot: layout.remoteInstall.workspaceRoot,
      });
      rpcFixtures.push(remoteRpc);
      cleanup.add("isolated remote application", () =>
        remoteRpc.stop(() =>
          stopRemoteLaneApplication(remoteApp, input.platform, layout.remoteInstall.dataRoot),
        ),
      );
      await runUpgradeLane({
        appBinaryPath: remoteApp,
        backendPort: assertRemoteInstallPort(input.updaterPort + 3),
        candidateVersion: input.candidateVersion,
        lane: "remote-install",
        baselineVersion,
        trigger: "remote-rpc",
        rpcFixture: remoteRpc,
        layout: layout.remoteInstall,
        platform: input.platform,
        projectId: `seed-${runId}-remote`,
        repositoryRoot: input.repositoryRoot,
        restartTimeoutMs: input.restartTimeoutMs,
        webdriverPort: assertRemoteInstallPort(input.updaterPort + 103),
        wsl: false,
      });
    }
  } catch (cause) {
    failure = cause;
  } finally {
    const secrets = [signingKey, signingPassword];
    let safeToRetainEvidence = true;
    try {
      for (const fixture of rpcFixtures) secrets.push(...(await fixture.readSecrets()));
    } catch {
      failure ??= new SeededDesktopUpgradeSmokeError(
        "Private remote fixture receipts were invalid; evidence was not retained.",
      );
      safeToRetainEvidence = false;
    }
    if (safeToRetainEvidence)
      await copyBoundedEvidence({
        artifactDirectory: input.artifactDirectory,
        layout,
        requestLogPath,
        secrets,
      }).catch(() => undefined);
    try {
      await cleanup.cleanup();
    } catch (cleanupError) {
      failure ??= cleanupError;
    }
  }
  if (failure !== undefined) throw failure;
}

async function main(): Promise<void> {
  const input = parseSeededDesktopUpgradeSmokeArgs(process.argv.slice(2));
  await runSeededDesktopUpgradeSmoke(input);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Seeded packaged-upgrade smoke failed.");
    process.exitCode = 1;
  });
}
