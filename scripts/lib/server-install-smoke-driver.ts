// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off - The standalone native driver bounds child processes and readiness polling.
// @effect-diagnostics globalFetch:off - The driver probes only a verified numeric loopback service address.
// @effect-diagnostics globalDate:off - Readiness deadlines use local monotonic-enough wall time around bounded probes.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import type {
  ServerInstallSmokeContext,
  ServerInstallSmokeDriver,
  ServerInstallSmokeScenarioResult,
} from "../server-install-smoke.ts";

interface CommandRequest {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowFailure?: boolean;
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

interface NativeDriverDependencies {
  readonly runCommand?: (
    request: CommandRequest,
    timeoutMs: number,
    abortSignal?: AbortSignal,
  ) => Promise<CommandResult>;
  readonly fetchJson?: (url: string, timeoutMs: number) => Promise<Record<string, unknown>>;
  readonly repoRoot?: string;
}

interface ServiceStatus {
  readonly state: string;
  readonly dataRoot: string;
  readonly bind: string;
  readonly definitionMatches: boolean;
  readonly mode?: string;
  readonly startupOwner?: string;
  readonly account?: string;
}

interface RuntimeIdentity {
  readonly environmentId: string;
  readonly storageInstanceId: string;
}

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SERVICE_READY_TIMEOUT_MS = 30_000;

const fail = (message: string): never => {
  throw new Error(message);
};

const defaultRunCommand = (
  request: CommandRequest,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    if (abortSignal?.aborted === true) {
      reject(new Error("A bounded native smoke command was cancelled."));
      return;
    }
    const child = NodeChildProcess.spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let failed = false;
    const abort = (): void => {
      failed = true;
      child.kill();
    };
    abortSignal?.addEventListener("abort", abort, { once: true });
    const observe = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        failed = true;
        child.kill();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => observe(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => observe([], chunk));
    const timer = setTimeout(() => {
      failed = true;
      child.kill();
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", abort);
      reject(new Error("A bounded native smoke command could not start."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", abort);
      const exitCode = code ?? -1;
      if (failed || (exitCode !== 0 && request.allowFailure !== true)) {
        reject(new Error("A bounded native smoke command failed."));
        return;
      }
      resolve({ exitCode, stdout: Buffer.concat(stdout).toString("utf8") });
    });
  });

const defaultFetchJson = async (
  url: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> => {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return fail("The native smoke endpoint returned an invalid status.");
  const value: unknown = await response.json();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("The native smoke endpoint returned invalid JSON.");
  }
  return value as Record<string, unknown>;
};

const parseJsonObject = (source: string): Record<string, unknown> => {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return fail("A native smoke command returned invalid JSON.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("A native smoke command returned an invalid JSON object.");
  }
  return value as Record<string, unknown>;
};

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    return fail(`Native smoke ${label} is invalid.`);
  }
  return value;
};

const requireObject = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(`Native smoke ${label} is invalid.`);
  }
  return value as Record<string, unknown>;
};

const parseServiceCommandStatus = (value: Record<string, unknown>): ServiceStatus => {
  const status = requireObject(value.status, "service status");
  return {
    state: requireString(status.state, "service state"),
    dataRoot: requireString(status.dataRoot, "service data root"),
    bind: requireString(status.bind, "service bind"),
    definitionMatches: status.definitionMatches === true,
    ...(typeof status.mode === "string" ? { mode: status.mode } : {}),
    ...(typeof status.startupOwner === "string" ? { startupOwner: status.startupOwner } : {}),
    ...(typeof status.account === "string" ? { account: status.account } : {}),
  };
};

const passed = (
  scenario: ServerInstallSmokeScenarioResult["scenario"],
  code: string,
  classification: "native" | "compatibility" = "native",
): ServerInstallSmokeScenarioResult => ({ scenario, status: "passed", classification, code });

const unavailable = (
  scenario: ServerInstallSmokeScenarioResult["scenario"],
  code: string,
): ServerInstallSmokeScenarioResult => ({
  scenario,
  status: "unavailable",
  classification: "unavailable",
  code,
});

class NativeServerInstallSmokeDriver implements ServerInstallSmokeDriver {
  private readonly runCommand: NonNullable<NativeDriverDependencies["runCommand"]>;
  private readonly fetchJson: NonNullable<NativeDriverDependencies["fetchJson"]>;
  private readonly repoRoot: string;
  private abortSignal: AbortSignal | undefined;
  private binaryPath: string | undefined;
  private dataRoot: string | undefined;
  private packageInstalled = false;
  private portableRoot: string | undefined;
  private headlessInstalled = false;
  private headlessAccountCreatedBySmoke = false;

  constructor(dependencies: NativeDriverDependencies) {
    const runCommand = dependencies.runCommand ?? defaultRunCommand;
    this.runCommand = (request, timeoutMs) => runCommand(request, timeoutMs, this.abortSignal);
    this.fetchJson = dependencies.fetchJson ?? defaultFetchJson;
    this.repoRoot = NodePath.resolve(
      dependencies.repoRoot ?? NodeURL.fileURLToPath(new URL("../..", import.meta.url)),
    );
  }

  async execute(
    context: ServerInstallSmokeContext,
  ): Promise<ReadonlyArray<ServerInstallSmokeScenarioResult>> {
    this.abortSignal = context.abortSignal;
    if (context.abortSignal.aborted) return fail("Native smoke execution was cancelled.");
    await this.requireFreshWorkstationHost(context);
    const expectedDataRoot = this.expectedDataRoot(context);
    if (this.isNativePackage(context) && NodeFS.existsSync(expectedDataRoot)) {
      return fail("Native smoke refuses a pre-existing workstation data root.");
    }
    const firstStatus = await this.install(context, expectedDataRoot);
    await this.assertIdempotentWorkstationInstall(context, expectedDataRoot);
    const firstIdentity = await this.descriptor(firstStatus, context.commandTimeoutMs);
    await this.runPackagedRuntimeTest(context);
    await this.restart(context, firstStatus.dataRoot);
    const restarted = await this.waitForRunningStatus(
      context,
      firstStatus.dataRoot,
      SERVICE_READY_TIMEOUT_MS,
    );
    const restartedIdentity = await this.descriptor(restarted, context.commandTimeoutMs);
    if (
      restartedIdentity.environmentId !== firstIdentity.environmentId ||
      restartedIdentity.storageInstanceId !== firstIdentity.storageInstanceId
    ) {
      return fail("Native service restart changed persisted identities.");
    }

    await this.runUpgradeLifecycle(context, firstStatus.dataRoot, firstIdentity);
    await this.runRollbackLifecycle(context, firstStatus.dataRoot, firstIdentity);

    await this.uninstall(context, firstStatus.dataRoot);
    if (!NodeFS.existsSync(firstStatus.dataRoot)) {
      return fail("Native package uninstall removed the preserved data root.");
    }
    const secondStatus = await this.install(context, firstStatus.dataRoot);
    const secondIdentity = await this.descriptor(secondStatus, context.commandTimeoutMs);
    if (
      secondIdentity.environmentId !== firstIdentity.environmentId ||
      secondIdentity.storageInstanceId !== firstIdentity.storageInstanceId
    ) {
      return fail("Native package reinstall did not adopt preserved identities.");
    }

    const headlessResult = this.isNativePackage(context)
      ? await this.runHeadlessLifecycle(context, secondStatus.dataRoot, secondIdentity)
      : unavailable("headless-account-and-acl", "requires-native-package");

    const purgeBinary = NodePath.join(
      context.workRoot,
      context.artifact.os === "windows" ? "purge-bibcode.exe" : "purge-bibcode",
    );
    const purgeSibling = NodePath.join(context.workRoot, "purge-sibling-canary");
    await NodeFSP.writeFile(purgeSibling, "preserve", { flag: "wx", mode: 0o600 });
    await NodeFSP.copyFile(this.requireBinary(), purgeBinary, NodeFS.constants.COPYFILE_EXCL);
    if (context.artifact.os !== "windows") await NodeFSP.chmod(purgeBinary, 0o700);
    const plan = await this.runJson(
      {
        command: this.requireBinary(),
        args: [
          "storage",
          "purge",
          "plan",
          "--environment-name",
          "Native smoke environment",
          "--base-dir",
          secondStatus.dataRoot,
          "--json",
        ],
      },
      context.commandTimeoutMs,
    );
    const planId = requireString(plan.planId, "purge plan identifier");
    await this.uninstall(context, secondStatus.dataRoot);
    await this.runCommand(
      {
        command: purgeBinary,
        args: [
          "storage",
          "purge",
          "execute",
          "--plan-id",
          planId,
          "--confirm-environment-name",
          "Native smoke environment",
          "--base-dir",
          secondStatus.dataRoot,
          "--json",
        ],
      },
      context.commandTimeoutMs,
    );
    if (NodeFS.existsSync(secondStatus.dataRoot)) {
      return fail("Typed native smoke purge did not remove the exact data root.");
    }
    if ((await NodeFSP.readFile(purgeSibling, "utf8")) !== "preserve") {
      return fail("Typed native smoke purge mutated a sibling canary.");
    }
    await this.runPackageLifecycleFailureGate(context);

    return [
      passed("clean-workstation-install", "installed-clean"),
      passed("single-loopback-service", "one-loopback-service"),
      passed("single-use-dpop-pairing", "packaged-dpop-rpc"),
      passed("same-origin-ui-without-node", "packaged-ui-no-node"),
      passed("restart-preserves-identities", "restart-identities-stable"),
      passed("upgrade-preserves-data-and-backup", "backup-activate-identities-stable"),
      passed("failed-upgrade-recovers-safely", "rollback-and-migration-gate-passed"),
      passed("uninstall-preserves-data", "uninstall-data-preserved"),
      passed("reinstall-adopts-identities", "reinstall-identities-stable"),
      passed("typed-purge-removes-exact-root", "typed-purge-complete"),
      headlessResult,
      passed("owned-process-and-temporary-cleanup", "owned-processes-reaped"),
    ];
  }

  async cleanup(context: ServerInstallSmokeContext): Promise<void> {
    this.abortSignal = context.abortSignal;
    if (this.headlessInstalled && this.binaryPath !== undefined) {
      await this.runElevated(
        context,
        this.binaryPath,
        this.serviceArgs("uninstall", this.defaultHeadlessDataRoot(context), "headless"),
      );
      this.headlessInstalled = false;
    }
    if (this.headlessAccountCreatedBySmoke) {
      await this.removeHeadlessAccount(context);
    }
    if (this.packageInstalled && this.binaryPath !== undefined && this.dataRoot !== undefined) {
      await this.uninstall(context, this.dataRoot);
    }
    if (this.portableRoot !== undefined && NodeFS.existsSync(this.portableRoot)) {
      const relative = NodePath.relative(context.workRoot, this.portableRoot);
      if (relative.startsWith("..") || NodePath.isAbsolute(relative)) {
        return fail("Portable cleanup escaped the native smoke work root.");
      }
      await NodeFSP.rm(this.portableRoot, { recursive: true, force: true });
    }
  }

  private isNativePackage(context: ServerInstallSmokeContext): boolean {
    return ["msi", "pkg", "deb", "rpm"].includes(context.artifact.format);
  }

  private async requireFreshWorkstationHost(context: ServerInstallSmokeContext): Promise<void> {
    if (this.isNativePackage(context) && NodeFS.existsSync(this.nativeBinaryPath(context))) {
      return fail("Native smoke refuses pre-existing package-owned server bytes.");
    }
    if (context.artifact.os === "windows") {
      const task = await this.runCommand(
        {
          command: "schtasks.exe",
          args: ["/Query", "/TN", "BiBCode"],
          allowFailure: true,
        },
        context.commandTimeoutMs,
      );
      if (task.exitCode === 0) {
        return fail("Native smoke refuses a pre-existing workstation task.");
      }
      return;
    }
    const home = process.env.HOME;
    if (!home || !NodePath.isAbsolute(home)) {
      return fail("Native smoke cannot resolve the workstation home directory.");
    }
    const definition =
      context.artifact.os === "macos"
        ? NodePath.join(home, "Library/LaunchAgents/com.bibcode.server.plist")
        : NodePath.join(home, ".config/systemd/user/bibcode.service");
    if (NodeFS.existsSync(definition)) {
      return fail("Native smoke refuses a pre-existing workstation service definition.");
    }
  }

  private expectedDataRoot(context: ServerInstallSmokeContext): string {
    if (!this.isNativePackage(context)) return NodePath.join(context.workRoot, "data");
    const home = context.artifact.os === "windows" ? process.env.USERPROFILE : process.env.HOME;
    if (!home || !NodePath.isAbsolute(home)) {
      return fail("Native smoke cannot resolve the disposable runner home directory.");
    }
    return NodePath.join(home, ".bibcode");
  }

  private nativeBinaryPath(context: ServerInstallSmokeContext): string {
    switch (context.artifact.os) {
      case "windows": {
        const localAppData = process.env.LOCALAPPDATA;
        if (!localAppData || !NodePath.isAbsolute(localAppData)) {
          return fail("Native smoke cannot resolve LocalAppData.");
        }
        return NodePath.join(localAppData, "Programs", "BiBCode Server", "bin", "bibcode.exe");
      }
      case "macos":
        return "/usr/local/libexec/bibcode-server/bin/bibcode";
      case "linux":
        return "/usr/bin/bibcode";
    }
  }

  private async install(
    context: ServerInstallSmokeContext,
    dataRoot: string,
  ): Promise<ServiceStatus> {
    if (this.isNativePackage(context)) {
      if (!context.allowSystemMutation) {
        return fail("Native package smoke requires explicit system-mutation consent.");
      }
      await this.installNativePackage(context);
      this.binaryPath = this.nativeBinaryPath(context);
      if (!NodeFS.existsSync(this.binaryPath)) {
        return fail("The native package did not install its declared server binary.");
      }
      this.dataRoot = dataRoot;
      this.packageInstalled = true;
      const installedStatus = await this.serviceStatus(context, dataRoot, true);
      if (installedStatus?.state.toLowerCase() !== "running") {
        await this.runCommand(
          {
            command: this.requireBinary(),
            args: this.serviceArgs("install", dataRoot),
          },
          context.commandTimeoutMs,
        );
      }
    } else {
      await this.installPortable(context);
      this.dataRoot = dataRoot;
      this.packageInstalled = true;
      await this.runCommand(
        {
          command: this.requireBinary(),
          args: this.serviceArgs("install", dataRoot),
        },
        context.commandTimeoutMs,
      );
    }
    return this.waitForRunningStatus(context, dataRoot, SERVICE_READY_TIMEOUT_MS);
  }

  private async installNativePackage(context: ServerInstallSmokeContext): Promise<void> {
    const logPath = NodePath.join(context.workRoot, "native-install.log");
    switch (context.artifact.format) {
      case "msi":
        await this.runCommand(
          {
            command: "msiexec.exe",
            args: ["/i", context.artifactPath, "/qn", "/norestart", "/l*v", logPath],
          },
          context.stageTimeoutMs,
        );
        return;
      case "pkg":
        await this.runCommand(
          {
            command: "sudo",
            args: ["/usr/sbin/installer", "-pkg", context.artifactPath, "-target", "/"],
          },
          context.stageTimeoutMs,
        );
        return;
      case "deb": {
        const packageUser = this.currentPackageUser();
        await this.runCommand(
          {
            command: "sudo",
            args: [
              "/usr/bin/env",
              "BIBCODE_PACKAGE_MODE=workstation",
              `BIBCODE_PACKAGE_USER=${packageUser}`,
              "/usr/bin/dpkg",
              "--install",
              context.artifactPath,
            ],
          },
          context.stageTimeoutMs,
        );
        return;
      }
      case "rpm": {
        const packageUser = this.currentPackageUser();
        await this.runCommand(
          {
            command: "sudo",
            args: [
              "/usr/bin/env",
              "BIBCODE_PACKAGE_MODE=workstation",
              `BIBCODE_PACKAGE_USER=${packageUser}`,
              "rpm",
              "--upgrade",
              "--replacepkgs",
              context.artifactPath,
            ],
          },
          context.stageTimeoutMs,
        );
        return;
      }
      default:
        return fail("The selected server artifact is not a native package.");
    }
  }

  private async installPortable(context: ServerInstallSmokeContext): Promise<void> {
    const payload = NodePath.join(context.workRoot, "portable-payload");
    if (NodeFS.existsSync(payload)) return fail("Portable smoke payload root is not fresh.");
    await NodeFSP.mkdir(payload, { mode: 0o700 });
    if (context.artifact.format === "zip") {
      await this.runCommand(
        {
          command: "powershell.exe",
          args: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1]",
            context.artifactPath,
            payload,
          ],
        },
        context.commandTimeoutMs,
      );
    } else if (context.artifact.format === "tar.gz") {
      await this.runCommand(
        { command: "tar", args: ["-xzf", context.artifactPath, "-C", payload] },
        context.commandTimeoutMs,
      );
    } else {
      return fail("The selected portable server artifact format is invalid.");
    }
    const binary = NodePath.join(
      payload,
      "bin",
      context.artifact.os === "windows" ? "bibcode.exe" : "bibcode",
    );
    const metadata = NodeFS.lstatSync(binary);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return fail("The portable server binary is not a plain file.");
    }
    this.binaryPath = binary;
    this.portableRoot = payload;
  }

  private currentPackageUser(): string {
    const user = process.env.USER ?? process.env.USERNAME;
    if (user === undefined || !/^[A-Za-z0-9._-]+$/u.test(user) || user === "root") {
      return fail("Native package smoke cannot resolve a safe non-root package account.");
    }
    return user;
  }

  private serviceArgs(
    operation: string,
    dataRoot: string,
    mode: "workstation" | "headless" = "workstation",
  ): ReadonlyArray<string> {
    return [
      "service",
      operation,
      "--mode",
      mode,
      "--host",
      "127.0.0.1",
      "--format",
      "json",
      "--base-dir",
      dataRoot,
    ];
  }

  private requireBinary(): string {
    if (this.binaryPath === undefined || !NodeFS.existsSync(this.binaryPath)) {
      return fail("The installed native smoke binary is unavailable.");
    }
    return this.binaryPath;
  }

  private async serviceStatus(
    context: ServerInstallSmokeContext,
    dataRoot: string,
    allowFailure: boolean,
  ): Promise<ServiceStatus | undefined> {
    const result = await this.runCommand(
      {
        command: this.requireBinary(),
        args: this.serviceArgs("status", dataRoot),
        allowFailure,
      },
      context.commandTimeoutMs,
    );
    if (result.exitCode !== 0) return undefined;
    const status = parseServiceCommandStatus(parseJsonObject(result.stdout));
    if (
      NodePath.resolve(status.dataRoot) !== NodePath.resolve(dataRoot) ||
      (status.state.toLowerCase() !== "notinstalled" && !status.definitionMatches) ||
      !/^127\.0\.0\.1:[1-9][0-9]*$/u.test(status.bind)
    ) {
      return fail("Native service status violates identity or loopback policy.");
    }
    return status;
  }

  private async waitForRunningStatus(
    context: ServerInstallSmokeContext,
    dataRoot: string,
    timeoutMs: number,
  ): Promise<ServiceStatus> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (context.abortSignal.aborted) {
        return fail("Native service readiness was cancelled.");
      }
      const status = await this.serviceStatus(context, dataRoot, true);
      if (status?.state.toLowerCase() === "running") return status;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return fail("Native service did not become running before the bounded deadline.");
  }

  private async descriptor(status: ServiceStatus, timeoutMs: number): Promise<RuntimeIdentity> {
    const descriptor = await this.fetchJson(
      `http://${status.bind}/.well-known/bibcode/environment`,
      timeoutMs,
    );
    const transport = descriptor.transport;
    if (
      transport === null ||
      typeof transport !== "object" ||
      Array.isArray(transport) ||
      (transport as Record<string, unknown>).mode !== "loopback-http"
    ) {
      return fail("Native service descriptor is not loopback-only.");
    }
    return {
      environmentId: requireString(descriptor.environmentId, "environment identity"),
      storageInstanceId: requireString(descriptor.storageInstanceId, "storage identity"),
    };
  }

  private async restart(context: ServerInstallSmokeContext, dataRoot: string): Promise<void> {
    await this.runCommand(
      { command: this.requireBinary(), args: this.serviceArgs("restart", dataRoot) },
      context.commandTimeoutMs,
    );
  }

  private async assertIdempotentWorkstationInstall(
    context: ServerInstallSmokeContext,
    dataRoot: string,
  ): Promise<void> {
    const result = await this.runJson(
      {
        command: this.requireBinary(),
        args: this.serviceArgs("install", dataRoot),
      },
      context.commandTimeoutMs,
    );
    const status = parseServiceCommandStatus(result);
    if (
      result.changed !== false ||
      status.state.toLowerCase() !== "running" ||
      !status.definitionMatches ||
      !/^127\.0\.0\.1:[1-9][0-9]*$/u.test(status.bind)
    ) {
      return fail("Native workstation service install is not one-definition idempotent.");
    }
  }

  private packageArgs(
    operation: "prepare" | "activate" | "rollback",
    context: ServerInstallSmokeContext,
    dataRoot: string,
    nonce: string,
  ): ReadonlyArray<string> {
    return [
      "package",
      operation,
      "--mode",
      "workstation",
      "--host",
      "127.0.0.1",
      "--format",
      "json",
      "--base-dir",
      dataRoot,
      "--nonce",
      nonce,
      "--target-version",
      context.manifest.version,
    ];
  }

  private assertIdentity(actual: RuntimeIdentity, expected: RuntimeIdentity, stage: string): void {
    if (
      actual.environmentId !== expected.environmentId ||
      actual.storageInstanceId !== expected.storageInstanceId
    ) {
      fail(`Native package ${stage} changed persisted identities.`);
    }
  }

  private async runUpgradeLifecycle(
    context: ServerInstallSmokeContext,
    dataRoot: string,
    expectedIdentity: RuntimeIdentity,
  ): Promise<void> {
    const nonce = `native-smoke-${NodeCrypto.randomUUID()}`;
    await this.runCommand(
      {
        command: this.requireBinary(),
        args: this.packageArgs("prepare", context, dataRoot, nonce),
      },
      context.stageTimeoutMs,
    );
    const inspection = await this.runJson(
      {
        command: this.requireBinary(),
        args: ["storage", "inspect", "--json", "--base-dir", dataRoot],
      },
      context.commandTimeoutMs,
    );
    if (
      !Array.isArray(inspection.backups) ||
      inspection.backups.length === 0 ||
      !Array.isArray(inspection.backupIssues) ||
      inspection.backupIssues.length !== 0 ||
      inspection.storageInstanceId !== expectedIdentity.storageInstanceId
    ) {
      return fail("Native package upgrade did not publish one verified identity-bound backup.");
    }
    await this.runCommand(
      {
        command: this.requireBinary(),
        args: this.packageArgs("activate", context, dataRoot, nonce),
      },
      context.stageTimeoutMs,
    );
    const status = await this.waitForRunningStatus(context, dataRoot, SERVICE_READY_TIMEOUT_MS);
    this.assertIdentity(
      await this.descriptor(status, context.commandTimeoutMs),
      expectedIdentity,
      "activation",
    );
  }

  private async runRollbackLifecycle(
    context: ServerInstallSmokeContext,
    dataRoot: string,
    expectedIdentity: RuntimeIdentity,
  ): Promise<void> {
    const nonce = `native-smoke-${NodeCrypto.randomUUID()}`;
    await this.runCommand(
      {
        command: this.requireBinary(),
        args: this.packageArgs("prepare", context, dataRoot, nonce),
      },
      context.stageTimeoutMs,
    );
    await this.runCommand(
      {
        command: this.requireBinary(),
        args: this.packageArgs("rollback", context, dataRoot, nonce),
      },
      context.stageTimeoutMs,
    );
    const status = await this.waitForRunningStatus(context, dataRoot, SERVICE_READY_TIMEOUT_MS);
    this.assertIdentity(
      await this.descriptor(status, context.commandTimeoutMs),
      expectedIdentity,
      "rollback",
    );
  }

  private defaultHeadlessDataRoot(context: ServerInstallSmokeContext): string {
    switch (context.artifact.os) {
      case "linux":
        return "/var/lib/bibcode";
      case "macos":
        return "/Library/Application Support/BiBCode";
      case "windows": {
        const programData = process.env.PROGRAMDATA;
        if (!programData || !NodePath.isAbsolute(programData)) {
          return fail("Native headless smoke cannot resolve ProgramData.");
        }
        return NodePath.join(programData, "BiBCode");
      }
    }
  }

  private elevatedRequest(
    context: ServerInstallSmokeContext,
    binary: string,
    args: ReadonlyArray<string>,
    allowFailure = false,
  ): CommandRequest {
    return context.artifact.os === "windows"
      ? { command: binary, args, allowFailure }
      : { command: "sudo", args: [binary, ...args], allowFailure };
  }

  private async runElevated(
    context: ServerInstallSmokeContext,
    binary: string,
    args: ReadonlyArray<string>,
    allowFailure = false,
  ): Promise<CommandResult> {
    return this.runCommand(
      this.elevatedRequest(context, binary, args, allowFailure),
      context.commandTimeoutMs,
    );
  }

  private async runElevatedJson(
    context: ServerInstallSmokeContext,
    binary: string,
    args: ReadonlyArray<string>,
  ): Promise<Record<string, unknown>> {
    return parseJsonObject((await this.runElevated(context, binary, args)).stdout);
  }

  private async waitForHeadlessStatus(
    context: ServerInstallSmokeContext,
    binary: string,
    dataRoot: string,
  ): Promise<ServiceStatus> {
    const deadline = Date.now() + SERVICE_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (context.abortSignal.aborted) {
        return fail("Native headless service readiness was cancelled.");
      }
      const result = await this.runElevated(
        context,
        binary,
        this.serviceArgs("status", dataRoot, "headless"),
        true,
      );
      if (result.exitCode === 0) {
        const status = parseServiceCommandStatus(parseJsonObject(result.stdout));
        if (status.state.toLowerCase() === "running") {
          if (
            NodePath.resolve(status.dataRoot) !== NodePath.resolve(dataRoot) ||
            !status.definitionMatches ||
            !/^127\.0\.0\.1:[1-9][0-9]*$/u.test(status.bind)
          ) {
            return fail("Native headless service violates root, definition, or loopback policy.");
          }
          return status;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return fail("Native headless service did not become running before the bounded deadline.");
  }

  private async assertHeadlessAcl(
    context: ServerInstallSmokeContext,
    dataRoot: string,
  ): Promise<void> {
    if (context.artifact.os === "linux") {
      const result = await this.runCommand(
        { command: "sudo", args: ["/usr/bin/stat", "--format=%a:%U:%G", dataRoot] },
        context.commandTimeoutMs,
      );
      if (result.stdout.trim() !== "750:bibcode:bibcode") {
        return fail("Native Linux headless data-root ownership or mode is invalid.");
      }
      return;
    }
    if (context.artifact.os === "macos") {
      const result = await this.runCommand(
        { command: "sudo", args: ["/usr/bin/stat", "-f", "%Lp:%Su:%Sg", dataRoot] },
        context.commandTimeoutMs,
      );
      if (result.stdout.trim() !== "700:_bibcode:wheel") {
        return fail("Native macOS headless data-root ownership or mode is invalid.");
      }
      return;
    }
    const result = await this.runCommand(
      {
        command: "powershell.exe",
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$acl=Get-Acl -LiteralPath $args[0];[pscustomobject]@{protected=$acl.AreAccessRulesProtected;rules=@($acl.Access|ForEach-Object{[string]$_.IdentityReference})}|ConvertTo-Json -Compress -Depth 3",
          dataRoot,
        ],
      },
      context.commandTimeoutMs,
    );
    const acl = parseJsonObject(result.stdout);
    const identities = JSON.stringify(acl.rules ?? []).toLowerCase();
    if (
      acl.protected !== true ||
      !identities.includes("nt service\\\\bibcode") ||
      !identities.includes("system") ||
      !identities.includes("administrators")
    ) {
      return fail("Native Windows headless data-root ACL is invalid.");
    }
  }

  private async requireFreshHeadlessAccount(context: ServerInstallSmokeContext): Promise<void> {
    if (context.artifact.os === "windows") return;
    const account = context.artifact.os === "macos" ? "_bibcode" : "bibcode";
    const result = await this.runCommand(
      { command: "/usr/bin/id", args: ["-u", account], allowFailure: true },
      context.commandTimeoutMs,
    );
    if (result.exitCode === 0) {
      return fail("Native headless smoke refuses a pre-existing dedicated account.");
    }
  }

  private async removeHeadlessAccount(context: ServerInstallSmokeContext): Promise<void> {
    if (context.artifact.os === "linux") {
      await this.runCommand(
        { command: "sudo", args: ["/usr/sbin/userdel", "bibcode"] },
        context.commandTimeoutMs,
      );
    } else if (context.artifact.os === "macos") {
      await this.runCommand(
        { command: "sudo", args: ["/usr/bin/dscl", ".", "-delete", "/Users/_bibcode"] },
        context.commandTimeoutMs,
      );
    }
    this.headlessAccountCreatedBySmoke = false;
  }

  private async runHeadlessLifecycle(
    context: ServerInstallSmokeContext,
    workstationRoot: string,
    workstationIdentity: RuntimeIdentity,
  ): Promise<ServerInstallSmokeScenarioResult> {
    const binary = this.requireBinary();
    const headlessRoot = this.defaultHeadlessDataRoot(context);
    if (NodeFS.existsSync(headlessRoot)) {
      return fail("Native headless smoke refuses a pre-existing headless data root.");
    }
    await this.requireFreshHeadlessAccount(context);
    const headlessBefore = parseServiceCommandStatus(
      await this.runElevatedJson(
        context,
        binary,
        this.serviceArgs("status", headlessRoot, "headless"),
      ),
    );
    if (headlessBefore.state.toLowerCase() !== "notinstalled") {
      return fail("Native headless smoke refuses a pre-existing service definition.");
    }
    await this.runCommand(
      { command: binary, args: this.serviceArgs("uninstall", workstationRoot) },
      context.commandTimeoutMs,
    );
    const install = await this.runElevatedJson(
      context,
      binary,
      this.serviceArgs("install", headlessRoot, "headless"),
    );
    this.headlessAccountCreatedBySmoke =
      context.artifact.os !== "windows" && install.accountCreated === true;
    this.headlessInstalled = true;
    if (install.accountCreated !== true) {
      return fail("Native headless service did not report its dedicated account creation.");
    }
    const status = await this.waitForHeadlessStatus(context, binary, headlessRoot);
    const expectedAccount =
      context.artifact.os === "windows"
        ? "nt service\\bibcode"
        : context.artifact.os === "macos"
          ? "_bibcode"
          : "bibcode";
    const expectedOwner =
      context.artifact.os === "windows"
        ? "windows-service"
        : context.artifact.os === "macos"
          ? "launch-daemon"
          : "systemd-system";
    if (
      status.mode !== "headless" ||
      status.account?.toLowerCase() !== expectedAccount ||
      status.startupOwner !== expectedOwner
    ) {
      return fail("Native headless service owner or account is invalid.");
    }
    await this.assertHeadlessAcl(context, headlessRoot);
    const plan = await this.runElevatedJson(context, binary, [
      "storage",
      "purge",
      "plan",
      "--environment-name",
      "Native headless smoke environment",
      "--base-dir",
      headlessRoot,
      "--json",
    ]);
    const planId = requireString(plan.planId, "headless purge plan identifier");
    const removed = await this.runElevatedJson(
      context,
      binary,
      this.serviceArgs("uninstall", headlessRoot, "headless"),
    );
    const expectedAccountRemoval = context.artifact.os === "windows";
    if (
      removed.accountRemovalPerformed !== expectedAccountRemoval ||
      removed.dataRootPreserved !== true
    ) {
      return fail("Native headless uninstall reported invalid account or data preservation.");
    }
    this.headlessInstalled = false;
    await this.runElevated(context, binary, [
      "storage",
      "purge",
      "execute",
      "--plan-id",
      planId,
      "--confirm-environment-name",
      "Native headless smoke environment",
      "--base-dir",
      headlessRoot,
      "--json",
    ]);
    if (NodeFS.existsSync(headlessRoot)) {
      return fail("Native headless smoke purge did not remove its exact data root.");
    }
    await this.removeHeadlessAccount(context);
    await this.runCommand(
      { command: binary, args: this.serviceArgs("install", workstationRoot) },
      context.commandTimeoutMs,
    );
    const restored = await this.waitForRunningStatus(
      context,
      workstationRoot,
      SERVICE_READY_TIMEOUT_MS,
    );
    this.assertIdentity(
      await this.descriptor(restored, context.commandTimeoutMs),
      workstationIdentity,
      "workstation restore after headless smoke",
    );
    return passed("headless-account-and-acl", "dedicated-account-acl-owner-verified");
  }

  private async uninstall(context: ServerInstallSmokeContext, dataRoot: string): Promise<void> {
    const binary = this.requireBinary();
    if (!this.isNativePackage(context)) {
      await this.runCommand(
        { command: binary, args: this.serviceArgs("uninstall", dataRoot) },
        context.commandTimeoutMs,
      );
      if (this.portableRoot !== undefined) {
        await NodeFSP.rm(this.portableRoot, { recursive: true, force: true });
        this.portableRoot = undefined;
      }
    } else {
      switch (context.artifact.format) {
        case "msi":
          await this.runCommand(
            {
              command: "msiexec.exe",
              args: ["/x", context.artifactPath, "/qn", "/norestart"],
            },
            context.stageTimeoutMs,
          );
          break;
        case "deb":
          await this.runCommand(
            { command: "sudo", args: ["/usr/bin/dpkg", "--remove", "bibcode-server"] },
            context.stageTimeoutMs,
          );
          break;
        case "rpm":
          await this.runCommand(
            { command: "sudo", args: ["rpm", "--erase", "bibcode-server"] },
            context.stageTimeoutMs,
          );
          break;
        case "pkg":
          await this.runCommand(
            { command: binary, args: this.serviceArgs("uninstall", dataRoot) },
            context.commandTimeoutMs,
          );
          for (const path of [
            "/usr/local/libexec/bibcode-server",
            "/usr/local/bin/bibcode",
            "/var/db/bibcode-server-package",
          ]) {
            await this.runCommand(
              { command: "sudo", args: ["/bin/rm", "-R", "-f", "--", path] },
              context.commandTimeoutMs,
            );
          }
          await this.runCommand(
            {
              command: "sudo",
              args: ["/usr/sbin/pkgutil", "--forget", "com.bibcode.server"],
              allowFailure: true,
            },
            context.commandTimeoutMs,
          );
          break;
      }
    }
    await this.assertWorkstationRemoved(context, binary);
    this.packageInstalled = false;
    this.binaryPath = undefined;
    this.dataRoot = undefined;
  }

  private async assertWorkstationRemoved(
    context: ServerInstallSmokeContext,
    priorBinary: string,
  ): Promise<void> {
    if (NodeFS.existsSync(priorBinary)) {
      return fail("Native uninstall retained package-owned server bytes.");
    }
    if (context.artifact.os === "windows") {
      const result = await this.runCommand(
        {
          command: "schtasks.exe",
          args: ["/Query", "/TN", "BiBCode"],
          allowFailure: true,
        },
        context.commandTimeoutMs,
      );
      if (result.exitCode === 0) {
        return fail("Native Windows uninstall retained the workstation task.");
      }
      return;
    }
    const home = process.env.HOME;
    if (!home || !NodePath.isAbsolute(home)) {
      return fail("Native uninstall cannot resolve the workstation home directory.");
    }
    const definition =
      context.artifact.os === "macos"
        ? NodePath.join(home, "Library/LaunchAgents/com.bibcode.server.plist")
        : NodePath.join(home, ".config/systemd/user/bibcode.service");
    if (NodeFS.existsSync(definition)) {
      return fail("Native uninstall retained the workstation service definition.");
    }
  }

  private async runJson(
    request: CommandRequest,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    return parseJsonObject((await this.runCommand(request, timeoutMs)).stdout);
  }

  private async runPackagedRuntimeTest(context: ServerInstallSmokeContext): Promise<void> {
    const runtimeRoot = NodePath.join(context.workRoot, "packaged-runtime");
    if (NodeFS.existsSync(runtimeRoot)) return fail("Packaged runtime smoke root is not fresh.");
    await this.runCommand(
      {
        command: process.execPath,
        args: [
          NodePath.join(this.repoRoot, "scripts/run-msvc-x64.mjs"),
          "cargo",
          "test",
          "-p",
          "bibcode-server",
          "--test",
          "packaged_server_smoke",
          "--",
          "--nocapture",
        ],
        cwd: this.repoRoot,
        env: {
          ...process.env,
          BIBCODE_PACKAGED_SERVER_BINARY: this.requireBinary(),
          BIBCODE_PACKAGED_SERVER_WORK_ROOT: runtimeRoot,
          BIBCODE_REQUIRE_PACKAGED_SERVER_BINARY: "1",
        },
      },
      context.stageTimeoutMs,
    );
  }

  private async runPackageLifecycleFailureGate(context: ServerInstallSmokeContext): Promise<void> {
    await this.runCommand(
      {
        command: process.execPath,
        args: [
          NodePath.join(this.repoRoot, "scripts/run-msvc-x64.mjs"),
          "cargo",
          "test",
          "-p",
          "bibcode-server",
          "--test",
          "package_lifecycle",
          "rollback_is_allowed_only_before_the_backup_schema_advances",
          "--",
          "--nocapture",
        ],
        cwd: this.repoRoot,
      },
      context.stageTimeoutMs,
    );
  }
}

export function createNativeServerInstallSmokeDriver(
  dependencies: NativeDriverDependencies = {},
): ServerInstallSmokeDriver {
  return new NativeServerInstallSmokeDriver(dependencies);
}
