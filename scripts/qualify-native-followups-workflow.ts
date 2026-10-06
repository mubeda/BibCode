#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Development-only fixed CI native visual caller retains closed status, never a production transport.
// @effect-diagnostics globalConsole:off - Emit only closed status/source metadata; raw errors remain private.
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@bibcode/shared/hostProcess";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import {
  parseSeededDesktopUpgradeSmokeArgs,
  runSeededDesktopUpgradeSmoke,
  type SeededDesktopUpgradeSmokeInput,
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
    input.bundle !== "nsis"
  )
    throw refused();
  return { partition: "windows-wsl" as const, expectedOriginals: 2 };
}
export function nativeFollowupWorkflowStatus(
  sourceSha: string,
  partition: "linux-menu-update" | "windows-wsl",
  status: "partition-complete" | "unavailable" | "failed",
  originalCount: number,
) {
  const count = partition === "linux-menu-update" ? 6 : 2;
  if (
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
    sourceSha,
    partition,
    status,
    originalCount,
    requiredPartitionOriginalCount: count,
    previewOriginalCount: 0,
    completeGroup: false,
    visualReview: "pending",
  };
}
function privateWrite(root: string, name: string, value: object) {
  NodeFS.mkdirSync(root, { recursive: true, mode: 0o700 });
  NodeFS.writeFileSync(NodePath.join(root, name), JSON.stringify(value) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
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
  try {
    await runSeededDesktopUpgradeSmoke(input);
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
      nativeFollowupWorkflowStatus(sourceSha, plan.partition, status, count),
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
