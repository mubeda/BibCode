#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Development-only fixed CI native visual caller retains closed status, never a production transport.
// @effect-diagnostics globalConsole:off - Emit only closed status/source metadata; raw errors remain private.
import {
  projectNativeDriverEvidence,
  type NativeDriverEvidence,
} from "./lib/native-driver-evidence.ts";
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@bibcode/shared/hostProcess";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import {
  parseSeededDesktopUpgradeSmokeArgs,
  runSeededDesktopUpgradeSmoke,
  type SeededDesktopUpgradeSmokeInput,
  nativeFollowupPhases,
  type NativeFollowupPhase,
  nativeFollowupLinuxServiceRoles,
  type NativeFollowupLinuxServiceAdmission,
} from "./seeded-desktop-upgrade-smoke.ts";
const refused = () => new Error("Native follow-up workflow admission refused.");
export function nativeFollowupWorkflowPlan(
  input: SeededDesktopUpgradeSmokeInput,
  host: {
    CI: string | undefined;
    actions: string | undefined;
    platform: string;
    uid: number | null;
    sourceSha: string;
  },
) {
  if (
    host.CI !== "true" ||
    host.actions !== "true" ||
    !/^[a-f0-9]{40}$/.test(host.sourceSha) ||
    input.nativeFollowups !== true ||
    input.arch !== "x64" ||
    input.repositoryRoot !== NodePath.resolve(input.repositoryRoot)
  )
    throw refused();
  if (input.platform === "linux") {
    if (
      host.platform !== "linux" ||
      host.uid === null ||
      host.uid === 0 ||
      input.wsl ||
      input.bundle !== "appimage"
    )
      throw refused();
    return { partition: "linux-menu-update" as const, expectedOriginals: 6 };
  }
  if (
    input.platform !== "win" ||
    host.platform !== "win32" ||
    !input.wsl ||
    !input.ownedWslManifest ||
    input.bundle !== "nsis"
  )
    throw refused();
  return { partition: "windows-wsl" as const, expectedOriginals: 2 };
}
/** Closed failed-boundary metadata only; native process and command guards remain authoritative. */
export function projectNativeFollowupLinuxServiceAdmission(
  value: unknown,
): Readonly<NativeFollowupLinuxServiceAdmission> | null {
  if (value === null) return null;
  const fields = (record: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      NodeUtil.types.isProxy(record)
    )
      throw refused();
    const own = Reflect.ownKeys(record);
    if (
      own.length !== keys.length ||
      !own.every((key) => typeof key === "string" && keys.includes(key))
    )
      throw refused();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const field = Object.getOwnPropertyDescriptor(record, key);
      if (!field?.enumerable || !Object.hasOwn(field, "value")) throw refused();
      result[key] = field.value;
    }
    return result;
  };
  const record = fields(value, ["driverOutcome", "services"]),
    driverOutcome = record.driverOutcome,
    services = record.services;
  if (driverOutcome !== "unknown" && driverOutcome !== "zero" && driverOutcome !== "nonzero")
    throw refused();
  if (
    !services ||
    typeof services !== "object" ||
    NodeUtil.types.isProxy(services) ||
    !Array.isArray(services)
  )
    throw refused();
  if (services.length !== 6 || Reflect.ownKeys(services).length !== 7) throw refused();
  const rows = nativeFollowupLinuxServiceRoles.map((role, index) => {
    const field = Object.getOwnPropertyDescriptor(services, String(index));
    if (!field?.enumerable || !Object.hasOwn(field, "value")) throw refused();
    const row = fields(field.value, ["role", "done", "overflow"]);
    if (row.role !== role || typeof row.done !== "boolean" || typeof row.overflow !== "boolean")
      throw refused();
    return Object.freeze({ role, done: row.done, overflow: row.overflow });
  });
  return Object.freeze({ driverOutcome, services: Object.freeze(rows) });
}

export function nativeFollowupWorkflowStatus(
  sourceSha: string,
  partition: "linux-menu-update" | "windows-wsl",
  status: "partition-complete" | "unavailable" | "failed",
  originalCount: number,
  phase: NativeFollowupPhase = "native-owner-start",
  linuxServiceAdmission: unknown = null,
  nativeDriverEvidence: unknown = null,
) {
  const observation = projectNativeFollowupLinuxServiceAdmission(linuxServiceAdmission);
  const driver =
    nativeDriverEvidence === null ? null : projectNativeDriverEvidence(nativeDriverEvidence);
  if (driver !== null && (partition !== "linux-menu-update" || status !== "failed"))
    throw refused();
  if (
    observation !== null &&
    (partition !== "linux-menu-update" ||
      status !== "failed" ||
      phase !== "native-linux-service-admission")
  )
    throw refused();
  const count = partition === "linux-menu-update" ? 6 : 2;
  if (
    !nativeFollowupPhases.includes(phase) ||
    !["linux-menu-update", "windows-wsl"].includes(partition) ||
    !["partition-complete", "unavailable", "failed"].includes(status) ||
    (status === "unavailable" && originalCount !== 0) ||
    !/^[a-f0-9]{40}$/.test(sourceSha) ||
    !Number.isInteger(originalCount) ||
    originalCount < 0 ||
    originalCount > count ||
    (status === "partition-complete" && originalCount !== count)
  )
    throw refused();
  return {
    schemaVersion: 1,
    selection: "release-visual-native-followups",
    phase,
    sourceSha,
    partition,
    status,
    originalCount,
    requiredPartitionOriginalCount: count,
    previewOriginalCount: 0,
    completeGroup: false,
    visualReview: "pending",
    ...(observation === null ? {} : { linuxServiceAdmission: observation }),
    ...(driver === null ? {} : { nativeDriverEvidence: driver }),
  };
}
function privateWrite(root: string, name: string, value: object) {
  NodeFS.mkdirSync(root, { recursive: true, mode: 0o700 });
  NodeFS.writeFileSync(NodePath.join(root, name), JSON.stringify(value) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
}
export function nativeFollowupFailedWindowsStatusEligible(
  environment: NodeJS.ProcessEnv,
  platform: string,
) {
  return (
    environment.CI === "true" &&
    environment.GITHUB_ACTIONS === "true" &&
    platform === "win32" &&
    environment.BIBCODE_NATIVE_STATUS_SELECTED === "true" &&
    environment.BIBCODE_NATIVE_STATUS_PREPARE_AVAILABLE === "true" &&
    environment.BIBCODE_NATIVE_STATUS_DEPENDENCIES === "success" &&
    environment.BIBCODE_NATIVE_STATUS_PREREQUISITE === "failure" &&
    environment.BIBCODE_NATIVE_STATUS_WRAPPER === "skipped" &&
    environment.BIBCODE_NATIVE_STATUS_CANCELLED === "false"
  );
}
export async function recordFailedNativeWindowsStatus(
  repository: string,
  sourceSha: string,
  owningHostProcessPlatform: string,
  environment: NodeJS.ProcessEnv,
) {
  if (
    !nativeFollowupFailedWindowsStatusEligible(environment, owningHostProcessPlatform) ||
    environment.GITHUB_SHA !== sourceSha ||
    !/^[a-f0-9]{40}$/.test(sourceSha)
  )
    throw refused();
  const temporary = environment.RUNNER_TEMP;
  if (
    !temporary ||
    !NodePath.isAbsolute(temporary) ||
    NodePath.resolve(temporary) !== temporary ||
    NodeFS.realpathSync(temporary) !== temporary ||
    !NodeFS.lstatSync(temporary).isDirectory() ||
    NodeFS.lstatSync(temporary).isSymbolicLink()
  )
    throw refused();
  const artifactDirectory = NodePath.join(temporary, "bibcode-native-followups-wsl", "evidence");
  for (const directory of [NodePath.dirname(artifactDirectory), artifactDirectory]) {
    let metadata: NodeFS.Stats | null = null;
    try {
      metadata = NodeFS.lstatSync(directory);
    } catch (error) {
      if (!NodeUtil.types.isNativeError(error) || !("code" in error) || error.code !== "ENOENT")
        throw error;
    }
    if (
      metadata !== null &&
      (!metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        NodeFS.realpathSync(directory) !== directory)
    )
      throw refused();
  }
  NodeFS.mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
  const { NativeFollowupCommandOwner } = await import(
    NodeURL.pathToFileURL(
      NodePath.join(
        repository,
        "apps/desktop/e2e/support/release-visual-native-followups-process.ts",
      ),
    ).href
  );
  const { secureNativeFollowupWindowsRoot } = await import(
    NodeURL.pathToFileURL(
      NodePath.join(
        repository,
        "apps/desktop/e2e/support/release-visual-native-followups-windows.ts",
      ),
    ).href
  );
  const commands = new NativeFollowupCommandOwner(
    environment,
    artifactDirectory,
    () => {},
    "win32",
  );
  let failed = false;
  let original: unknown;
  try {
    await secureNativeFollowupWindowsRoot(
      commands,
      NodePath.join(
        environment.SystemRoot ?? "",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      artifactDirectory,
    );
  } catch (error) {
    failed = true;
    original = error;
  }
  try {
    commands.assertClosed();
  } catch (error) {
    if (!failed) {
      failed = true;
      original = error;
    }
  }
  if (failed) throw original;
  privateWrite(
    artifactDirectory,
    "native-followups-workflow-status.json",
    nativeFollowupWorkflowStatus(sourceSha, "windows-wsl", "failed", 0),
  );
}
async function main() {
  const repository = NodePath.resolve(NodeURL.fileURLToPath(new URL("..", import.meta.url))),
    sourceSha = process.env.GITHUB_SHA ?? "";
  const actual = NodeChildProcess.spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 4096,
  });
  if (
    actual.status !== 0 ||
    actual.stdout.trim() !== sourceSha ||
    process.env.CI !== "true" ||
    process.env.GITHUB_ACTIONS !== "true"
  )
    throw refused();
  const owningHostProcessPlatform = Effect.runSync(HostProcessPlatform);
  const args = process.argv.slice(2);
  if (args[0] === "--failed-windows-prerequisite-status") {
    if (args.length !== 1) throw refused();
    await recordFailedNativeWindowsStatus(
      repository,
      sourceSha,
      owningHostProcessPlatform,
      process.env,
    );
    return;
  }
  const input = parseSeededDesktopUpgradeSmokeArgs(args, repository);
  const plan = nativeFollowupWorkflowPlan(input, {
    CI: process.env.CI,
    actions: process.env.GITHUB_ACTIONS,
    platform: owningHostProcessPlatform,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    sourceSha,
  });
  let status: "partition-complete" | "failed" = "failed",
    count = 0;
  const observation: {
    phase: NativeFollowupPhase;
    linuxServiceAdmission: Readonly<NativeFollowupLinuxServiceAdmission> | null;
    nativeDriverEvidence: NativeDriverEvidence | null;
  } = { phase: "native-owner-start", linuxServiceAdmission: null, nativeDriverEvidence: null };
  try {
    await runSeededDesktopUpgradeSmoke({
      ...input,
      observeNativeFollowupDriverEvidence: (value) => {
        observation.nativeDriverEvidence = projectNativeDriverEvidence(value);
      },
      observeNativeFollowupPhase: (value) => {
        observation.phase = value;
      },
      observeNativeFollowupLinuxServiceAdmission: (value) => {
        observation.linuxServiceAdmission = projectNativeFollowupLinuxServiceAdmission(value);
      },
    });
    observation.phase = "native-result-admission";
    const retained = JSON.parse(
      NodeFS.readFileSync(
        NodePath.join(input.artifactDirectory, "native-followups-result.json"),
        "utf8",
      ),
    );
    if (
      retained.sourceSha !== sourceSha ||
      retained.partition !== plan.partition ||
      retained.partitionComplete !== true ||
      retained.originalCount !== plan.expectedOriginals ||
      retained.complete !== false ||
      retained.cleanup !== "joined"
    )
      throw refused();
    status = "partition-complete";
    count = plan.expectedOriginals;
  } catch (error) {
    const privateRoot = NodePath.join(input.workRoot, input.runId, "native-workflow-private");
    NodeFS.mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
    if (owningHostProcessPlatform === "win32") {
      const { NativeFollowupCommandOwner } = await import(
        NodeURL.pathToFileURL(
          NodePath.join(
            repository,
            "apps/desktop/e2e/support/release-visual-native-followups-process.ts",
          ),
        ).href
      );
      const { secureNativeFollowupWindowsRoot } = await import(
        NodeURL.pathToFileURL(
          NodePath.join(
            repository,
            "apps/desktop/e2e/support/release-visual-native-followups-windows.ts",
          ),
        ).href
      );
      const commands = new NativeFollowupCommandOwner(process.env, privateRoot, () => {}, "win32");
      await secureNativeFollowupWindowsRoot(
        commands,
        NodePath.join(
          process.env.SystemRoot ?? "",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        privateRoot,
      );
      commands.assertClosed();
    }
    // No unknown/native error is printed or included in retained artifacts.
    NodeFS.writeFileSync(
      NodePath.join(privateRoot, "native-followups-workflow-error.private.log"),
      error instanceof Error ? (error.stack ?? error.name) : "Unknown owned error",
      { mode: 0o600 },
    );
    process.exitCode = 1;
  } finally {
    if (owningHostProcessPlatform === "win32") {
      const { NativeFollowupCommandOwner } = await import(
        NodeURL.pathToFileURL(
          NodePath.join(
            repository,
            "apps/desktop/e2e/support/release-visual-native-followups-process.ts",
          ),
        ).href
      );
      const { secureNativeFollowupWindowsRoot } = await import(
        NodeURL.pathToFileURL(
          NodePath.join(
            repository,
            "apps/desktop/e2e/support/release-visual-native-followups-windows.ts",
          ),
        ).href
      );
      NodeFS.mkdirSync(input.artifactDirectory, { recursive: true, mode: 0o700 });
      const commands = new NativeFollowupCommandOwner(
        process.env,
        input.artifactDirectory,
        () => {},
        "win32",
      );
      await secureNativeFollowupWindowsRoot(
        commands,
        NodePath.join(
          process.env.SystemRoot ?? "",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        input.artifactDirectory,
      );
      commands.assertClosed();
    }
    privateWrite(
      input.artifactDirectory,
      "native-followups-workflow-status.json",
      nativeFollowupWorkflowStatus(
        sourceSha,
        plan.partition,
        status,
        count,
        observation.phase,
        observation.phase === "native-linux-service-admission"
          ? observation.linuxServiceAdmission
          : null,
        status === "failed" ? observation.nativeDriverEvidence : null,
      ),
    );
  }
}
if (import.meta.url === NodeURL.pathToFileURL(process.argv[1] ?? "").href)
  main().catch(() => {
    console.log(
      JSON.stringify({ selection: "release-visual-native-followups", status: "refused" }),
    );
    process.exitCode = 1;
  });
