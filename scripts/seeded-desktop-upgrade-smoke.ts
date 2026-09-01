#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This release harness owns host processes and paths.
// @effect-diagnostics globalConsole:off - The standalone harness reports bounded progress.
// @effect-diagnostics globalFetch:off - The standalone harness probes its loopback update server.
// @effect-diagnostics globalTimers:off - The standalone harness owns bounded process timeouts.
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import { MOCK_UPDATE_LOOPBACK_HOST, MOCK_UPDATE_READY_PATH } from "./mock-update-server.ts";
import { requireReleaseTarget, type TauriUpdaterTarget } from "./lib/release-targets.ts";

export type SeededUpgradePlatform = "linux" | "mac" | "win";
export type SeededUpgradeArch = "arm64" | "x64";
export type SeededUpgradeLane = "previous-stable" | "protected-baseline";

const MOCK_UPDATE_READY_TIMEOUT_MS = 60_000;

export interface SeededDesktopUpgradeSmokeInput {
  readonly arch: SeededUpgradeArch;
  readonly artifactDirectory: string;
  readonly bundle: "appimage" | "dmg" | "nsis";
  readonly candidateVersion: string;
  readonly platform: SeededUpgradePlatform;
  readonly previousTag: string;
  readonly previousVersion: string;
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
  readonly previousStable: SeededUpgradeLaneLayout;
  readonly protectedBaseline: SeededUpgradeLaneLayout;
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
  if (updaterPort + 102 > 65_535) {
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
    previousStable: laneLayout(runRoot, "previous"),
    protectedBaseline: laneLayout(runRoot, "protected"),
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
  readonly expectedDataRoot: string;
  readonly lane: SeededUpgradeLane;
  readonly phase: "seed-and-install" | "verify";
  readonly projectId: string;
  readonly resultPath: string;
  readonly workspaceRoot: string;
  readonly wsl?: boolean | undefined;
}): string {
  const serializedInput = JSON.stringify(input).replaceAll("<", "\\u003c");
  return `
// Generated by scripts/seeded-desktop-upgrade-smoke.ts. Never persist database contents here.
import * as NodeFS from "node:fs";

const input = ${serializedInput};

async function observe(seed) {
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
    const observation = await observe(${input.phase === "seed-and-install" ? "true" : "false"});
    NodeFS.writeFileSync(input.resultPath, JSON.stringify(observation));
    ${
      input.phase === "seed-and-install"
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
  if (lane === "previous-stable") return;
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

const redactLiteral = (text: string, value: string): string =>
  value.length === 0 ? text : text.split(value).join("[REDACTED]");

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
    .reduce(redactLiteral, text);
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
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-262_144);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-262_144);
    });
    const timeout =
      input.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (settled) return;
            settled = true;
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
      reject(error);
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      resolve({ exitCode: code ?? 1, stderr, stdout });
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
  const exactCommand = appBinaryPath.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  return {
    args: ["-TERM", "-f", `^${exactCommand}([[:space:]]|$)`],
    command: "pkill",
  };
}

const stopRestartedApplication = async (
  appBinaryPath: string,
  platform: SeededUpgradePlatform,
): Promise<void> => {
  const plan = restartedApplicationCleanupPlan(appBinaryPath, platform);
  let killed = false;
  let missesAfterKill = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await runCommand({
      ...plan,
      cwd: NodePath.dirname(appBinaryPath),
      timeoutMs: 10_000,
    });
    if (result.exitCode === 0) {
      killed = true;
      missesAfterKill = 0;
    } else if (killed) {
      missesAfterKill += 1;
      if (missesAfterKill >= 2) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
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

const buildPackagedApplication = async (input: {
  readonly arch: SeededUpgradeArch;
  readonly bundle: SeededDesktopUpgradeSmokeInput["bundle"];
  readonly checkout: string;
  readonly overlayPath: string;
  readonly platform: SeededUpgradePlatform;
  readonly signingEnvironment: NodeJS.ProcessEnv;
  readonly targetDirectory: string;
}): Promise<void> => {
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
  mochaOpts: { ui: "bdd", timeout: ${Math.max(input.restartTimeoutMs, 120_000)} },
};
`;

const runWebDriverPhase = async (input: {
  readonly appBinaryPath: string;
  readonly backendPort: number;
  readonly candidateVersion: string;
  readonly dataRoot: string;
  readonly evidenceDirectory: string;
  readonly expectedDataRoot: string;
  readonly lane: SeededUpgradeLane;
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
  const phaseRoot = NodePath.join(input.runRoot, `${input.phase}-driver`);
  await NodeFS.promises.mkdir(phaseRoot, { recursive: true });
  const specPath = NodePath.join(phaseRoot, "seeded-upgrade.e2e.ts");
  const configPath = NodePath.join(phaseRoot, "wdio.conf.mjs");
  await NodeFS.promises.writeFile(specPath, createSeededUpgradeDriverSpec(input), { mode: 0o600 });
  await NodeFS.promises.writeFile(
    configPath,
    createSeededUpgradeWdioConfig({
      appBinaryPath: input.appBinaryPath,
      artifactDirectory: input.evidenceDirectory,
      restartTimeoutMs: input.restartTimeoutMs,
      specPath,
      webdriverPort: input.webdriverPort,
    }),
    { mode: 0o600 },
  );
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
    timeoutMs:
      input.phase === "seed-and-install"
        ? input.restartTimeoutMs + 90_000
        : input.restartTimeoutMs + 30_000,
  });
  const resultExists = NodeFS.existsSync(input.resultPath);
  await NodeFS.promises.writeFile(
    NodePath.join(input.evidenceDirectory, `${input.phase}.log`),
    redactAndBoundUpgradeEvidence(`${result.stdout}\n${result.stderr}`, {
      maxBytes: 64 * 1024,
      roots: [input.dataRoot, input.runRoot],
      secrets: [],
    }),
  );
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
  assertWebDriverPhaseExit({
    exitCode: result.exitCode,
    installAttempted,
    lane: input.lane,
    phase: input.phase,
  });
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

const runUpgradeLane = async (input: {
  readonly appBinaryPath: string;
  readonly backendPort: number;
  readonly candidateVersion: string;
  readonly layout: SeededUpgradeLaneLayout;
  readonly lane: SeededUpgradeLane;
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
    dataRoot: input.layout.dataRoot,
    evidenceDirectory: input.layout.evidenceDirectory,
    expectedDataRoot: input.layout.dataRoot,
    lane: input.lane,
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
  await stopRestartedApplication(input.appBinaryPath, input.platform);
  await runWebDriverPhase({ ...shared, phase: "verify", resultPath: afterPath });
  const before = await readObservation<SeededUpgradeObservationBefore>(beforePath);
  const after = await readObservation<SeededUpgradeObservationAfter>(afterPath);
  verifySeededUpgradeOutcome(input.lane, before, after, input.candidateVersion);
  await NodeFS.promises.writeFile(
    NodePath.join(input.layout.evidenceDirectory, "result.json"),
    `${JSON.stringify({
      lane: input.lane,
      candidateVersion: input.candidateVersion,
      observedAppVersion: after.appVersion,
      projectRetained: true,
      storageIdentityRetained:
        before.storageInstanceId === null || before.storageInstanceId === after.storageInstanceId,
      preUpdateBackupObserved:
        input.lane === "previous-stable" || after.preUpdateBackups.length > 0,
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

    await buildPackagedApplication({
      arch: input.arch,
      bundle: input.bundle,
      checkout: input.repositoryRoot,
      overlayPath: candidateOverlay,
      platform: input.platform,
      signingEnvironment,
      targetDirectory: layout.candidateBuildRoot,
    });
    if (!input.wsl) {
      await buildPackagedApplication({
        arch: input.arch,
        bundle: input.bundle,
        checkout: layout.previousStable.checkout,
        overlayPath: previousOverlay,
        platform: input.platform,
        signingEnvironment,
        targetDirectory: layout.previousStable.buildRoot,
      });
    }
    await buildPackagedApplication({
      arch: input.arch,
      bundle: input.bundle,
      checkout: layout.protectedBaseline.checkout,
      overlayPath: protectedOverlay,
      platform: input.platform,
      signingEnvironment,
      targetDirectory: layout.protectedBaseline.buildRoot,
    });
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
      await runUpgradeLane({
        appBinaryPath: previousApp,
        backendPort: input.updaterPort + 1,
        candidateVersion: input.candidateVersion,
        lane: "previous-stable",
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
      layout: layout.protectedBaseline,
      platform: input.platform,
      projectId: `seed-${runId}-protected`,
      repositoryRoot: input.repositoryRoot,
      restartTimeoutMs: input.restartTimeoutMs,
      webdriverPort: input.updaterPort + 102,
      wsl: input.wsl,
    });
  } catch (cause) {
    failure = cause;
  } finally {
    await copyBoundedEvidence({
      artifactDirectory: input.artifactDirectory,
      layout,
      requestLogPath,
      secrets: [signingKey, signingPassword],
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
