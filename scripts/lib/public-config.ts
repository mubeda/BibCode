// @effect-diagnostics nodeBuiltinImport:off - Build bootstrap reads optional root env files before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { readBiBCodeEnvironmentVariable } from "@bibcode/shared/environmentIdentity";

type Environment = Readonly<Record<string, string | undefined>>;

const REPO_ROOT = NodePath.dirname(
  NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url))),
);

const COMPATIBLE_ENVIRONMENT_SUFFIXES = [
  "APPLE_TEAM_ID",
  "AUTO_BOOTSTRAP_PROJECT_FROM_CWD",
  "BITBUCKET_ACCESS_TOKEN",
  "BITBUCKET_API_BASE_URL",
  "BITBUCKET_API_TOKEN",
  "BITBUCKET_EMAIL",
  "DEV_INSTANCE",
  "HOME",
  "HOST",
  "LOG",
  "LOG_WS_EVENTS",
  "MACOS_PROVISIONING_PROFILE",
  "MODE",
  "NO_BROWSER",
  "PORT",
  "PORT_OFFSET",
  "TAURI_DESKTOP_ALLOW_CROSS_PLATFORM",
  "TAURI_DESKTOP_ARCH",
  "TAURI_DESKTOP_OUTPUT_DIR",
  "TAURI_DESKTOP_PLATFORM",
  "TAURI_DESKTOP_SKIP_BUILD",
  "TAURI_DESKTOP_TARGET",
  "TAURI_DESKTOP_UPDATER",
  "TAURI_DESKTOP_VERBOSE",
  "WEB_SOURCEMAP",
  "WSL_SERVER_BINARY",
] as const;

export function loadRepoEnv({
  baseEnv = process.env,
  repoRoot = REPO_ROOT,
}: {
  readonly baseEnv?: Environment;
  readonly repoRoot?: string;
} = {}): Record<string, string | undefined> {
  const rootEnv = readEnvFile(NodePath.join(repoRoot, ".env"));
  const localEnv = readEnvFile(NodePath.join(repoRoot, ".env.local"));
  const env: Record<string, string | undefined> = {
    ...rootEnv,
    ...localEnv,
    ...baseEnv,
  };
  for (const suffix of COMPATIBLE_ENVIRONMENT_SUFFIXES) {
    env[`BIBCODE_${suffix}`] = readBiBCodeEnvironmentVariable(env, suffix);
  }
  return env;
}

function readEnvFile(path: string): Record<string, string | undefined> {
  return NodeFS.existsSync(path) ? NodeUtil.parseEnv(NodeFS.readFileSync(path, "utf8")) : {};
}
