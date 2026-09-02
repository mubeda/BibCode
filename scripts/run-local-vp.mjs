#!/usr/bin/env node
// Runs the checkout-local Vite+ (`vp`) installation.
//
// A globally installed `vp` can load its own bundled Vitest while the workspace
// test files import `vite-plus/test` from `node_modules`, which yields
// "Vitest failed to find the runner" before any test collects. This launcher
// never consults PATH: it resolves `node_modules/vite-plus` from the
// repository root and executes that package's `vp` entry with the current
// Node, so PowerShell, Parallels `prlctl exec --current-user`, and POSIX
// shells all run exactly one Vitest runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const LOCAL_VP_PACKAGE = "vite-plus";
export const LOCAL_VP_BIN_NAME = "vp";
export const LOCAL_VP_MISSING_EXIT_CODE = 3;

const REINSTALL_HINT = "Reinstall workspace dependencies and retry.";

export function defaultRepoRoot() {
  return NodePath.resolve(import.meta.dirname, "..");
}

/**
 * Resolves the local Vite+ command without touching PATH.
 *
 * @returns {{ kind: "resolved", binPath: string, version: string, packagePath: string }
 *   | { kind: "missing", message: string }}
 */
export function resolveLocalVitePlus(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot();
  const existsSync = options.existsSync ?? NodeFS.existsSync;
  const readFileSync = options.readFileSync ?? NodeFS.readFileSync;
  const packageDirectory = NodePath.join(repoRoot, "node_modules", LOCAL_VP_PACKAGE);
  const packagePath = NodePath.join(packageDirectory, "package.json");
  if (!existsSync(packagePath)) {
    return {
      kind: "missing",
      message: [
        `Workspace dependencies are not installed: ${packagePath} does not exist.`,
        "Run `vp install --frozen-lockfile` (or `pnpm install --frozen-lockfile`)",
        `from ${repoRoot} as the same account that runs the tests, then retry.`,
      ].join(" "),
    };
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      kind: "missing",
      message: `Could not read ${packagePath}: ${detail}. ${REINSTALL_HINT}`,
    };
  }
  const bin = manifest?.bin;
  const relativeBin =
    typeof bin === "string"
      ? bin
      : bin !== null && typeof bin === "object" && typeof bin[LOCAL_VP_BIN_NAME] === "string"
        ? bin[LOCAL_VP_BIN_NAME]
        : undefined;
  if (relativeBin === undefined) {
    return {
      kind: "missing",
      message: [
        `${packagePath} does not declare a \`${LOCAL_VP_BIN_NAME}\` bin entry.`,
        REINSTALL_HINT,
      ].join(" "),
    };
  }
  const binPath = NodePath.join(packageDirectory, relativeBin);
  if (!existsSync(binPath)) {
    return {
      kind: "missing",
      message: `The local Vite+ entry ${binPath} does not exist. ${REINSTALL_HINT}`,
    };
  }
  return {
    kind: "resolved",
    binPath,
    packagePath,
    version: typeof manifest.version === "string" ? manifest.version : "unknown",
  };
}

export function runLocalVp(args, options = {}) {
  const consoleError = options.consoleError ?? console.error;
  const spawnSync = options.spawnSync ?? NodeChildProcess.spawnSync;
  const resolved = resolveLocalVitePlus(options);
  if (resolved.kind === "missing") {
    consoleError(`[run-local-vp] ${resolved.message}`);
    return LOCAL_VP_MISSING_EXIT_CODE;
  }
  const result = spawnSync(options.execPath ?? process.execPath, [resolved.binPath, ...args], {
    stdio: "inherit",
    shell: false,
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
  });
  if (result.error) {
    consoleError(`[run-local-vp] Could not start ${resolved.binPath}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href
) {
  process.exit(runLocalVp(process.argv.slice(2)));
}
