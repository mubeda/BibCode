// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  releaseCargoLockFile,
  releasePackageFiles,
  releaseRustPackageFiles,
} from "./update-release-package-versions.ts";

const defaultRepoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);

export const releaseSmokeWorkspaceFiles = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ...releasePackageFiles,
  ...releaseRustPackageFiles,
  releaseCargoLockFile,
  "apps/marketing/package.json",
  "oxlint-plugin-bibcode/package.json",
  "packages/client-runtime/package.json",
  "packages/shared/package.json",
  "scripts/package.json",
] as const;

const releaseSmokeVersion = "9.9.9-smoke.0";

export interface ReleaseSmokeExecOptions {
  readonly cwd: string;
  readonly encoding?: "utf8";
  readonly stdio?: "inherit";
}

export interface ReleaseSmokeSpawnOptions {
  readonly cwd: string;
  readonly encoding: "utf8";
  readonly stdio: ["ignore", "pipe", "pipe"];
}

export interface ReleaseSmokeSpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
  readonly error?: Error;
}

export interface ReleaseSmokeRuntime {
  readonly execFile: (
    command: string,
    args: ReadonlyArray<string>,
    options: ReleaseSmokeExecOptions,
  ) => string;
  readonly spawn: (
    command: string,
    args: ReadonlyArray<string>,
    options: ReleaseSmokeSpawnOptions,
  ) => ReleaseSmokeSpawnResult;
}

export interface ReleaseSmokeOptions {
  readonly repoRoot?: string;
  readonly tempRoot?: string;
  readonly runtime: ReleaseSmokeRuntime;
  readonly verifyBuiltArtifacts?: boolean;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly log?: (text: string) => void;
}

const retiredDependencyMarkers = [
  ["@clerk", ""].join("/"),
  ["alchemy", "effect"].join("-"),
  ["@effect", "sql-pg"].join("/"),
  ["ed25519", "dalek"].join("-"),
  ["@cloudflare", "workers-types"].join("/"),
] as const;

const retiredArtifactMarkers = [
  ["BiBCode", "Connect"].join(" "),
  ["bibcode", "connect"].join("-"),
  ["connect", "mcp"].join("_"),
  ["Connect", "Mcp"].join(""),
  ["Relay", "ConnectionTarget"].join(""),
  ["Relay", "ConnectionRegistration"].join(""),
  ["Managed", "Relay"].join(""),
  ["managed", "endpoint"].join("_"),
  ["Managed", "Endpoint"].join(""),
  ["cloud", "flared"].join(""),
  ["BIBCODE", "RELAY"].join("_"),
  ["VITE", "BIBCODE", "RELAY"].join("_"),
  ["BIBCODE", "CLERK"].join("_"),
  ["VITE", "CLERK"].join("_"),
  ["@clerk", ""].join("/"),
  ["SCOPE", "RELAY"].join("_"),
  ["Auth", "Relay"].join(""),
  ["", "api", "connect"].join("/"),
  ["cloud", "getRelayClientStatus"].join("."),
  ["cloud", "installRelayClient"].join("."),
  ["infra", "relay"].join("/"),
] as const;

const boundedMigrationArtifactMarker = ["Relay", "ConnectionTarget"].join("");

function countBufferOccurrences(source: Buffer, marker: string): number {
  const needle = Buffer.from(marker, "utf8");
  let count = 0;
  let offset = 0;
  while (offset <= source.length - needle.length) {
    const found = source.indexOf(needle, offset);
    if (found < 0) break;
    count += 1;
    offset = found + needle.length;
  }
  return count;
}

export function assertNoLegacyCloudDependencies(repoRoot: string): void {
  for (const relativePath of ["pnpm-lock.yaml", "Cargo.lock"] as const) {
    const path = NodePath.resolve(repoRoot, relativePath);
    if (!NodeFS.existsSync(path)) {
      throw new Error(`Expected dependency inventory ${relativePath}.`);
    }
    const source = NodeFS.readFileSync(path, "utf8");
    for (const marker of retiredDependencyMarkers) {
      if (source.toLocaleLowerCase("en-US").includes(marker.toLocaleLowerCase("en-US"))) {
        throw new Error(`Retired dependency marker '${marker}' remains in ${relativePath}.`);
      }
    }
  }
}

export function assertNoLegacyCloudArtifacts(
  repoRoot: string,
  artifactPaths: ReadonlyArray<string>,
): void {
  if (artifactPaths.length === 0) throw new Error("Expected built artifacts to scan.");

  let boundedMigrationOccurrences = 0;
  for (const path of artifactPaths) {
    if (!NodeFS.existsSync(path) || !NodeFS.statSync(path).isFile()) {
      throw new Error(`Expected built artifact ${NodePath.relative(repoRoot, path)}.`);
    }
    const source = NodeFS.readFileSync(path);
    for (const marker of retiredArtifactMarkers) {
      const occurrences = countBufferOccurrences(source, marker);
      if (occurrences === 0) continue;
      const relativePath = NodePath.relative(repoRoot, path);
      if (
        marker === boundedMigrationArtifactMarker &&
        relativePath.startsWith(NodePath.join("apps", "web", "dist") + NodePath.sep)
      ) {
        boundedMigrationOccurrences += occurrences;
        continue;
      }
      throw new Error(`Retired product marker '${marker}' remains in ${relativePath}.`);
    }
  }
  if (boundedMigrationOccurrences > 2) {
    throw new Error(
      `Bounded catalog migration marker appears ${boundedMigrationOccurrences} times in web artifacts.`,
    );
  }
}

function artifactFiles(path: string): ReadonlyArray<string> {
  if (!NodeFS.existsSync(path)) return [];
  return NodeFS.readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = NodePath.join(path, entry.name);
    return entry.isDirectory() ? artifactFiles(child) : entry.isFile() ? [child] : [];
  });
}

function buildAndVerifyLegacyCloudFreeArtifacts(
  repoRoot: string,
  runtime: ReleaseSmokeRuntime,
  log: (text: string) => void,
): void {
  runtime.execFile("vp", ["run", "--filter", "@bibcode/web", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  runtime.execFile(
    process.execPath,
    [
      NodePath.resolve(repoRoot, "scripts/run-msvc-x64.mjs"),
      "cargo",
      "build",
      "-p",
      "bibcode-server",
      "--release",
      "--bin",
      "bibcode",
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );

  const webArtifacts = artifactFiles(NodePath.resolve(repoRoot, "apps/web/dist"));
  const serverCandidates = [
    NodePath.resolve(repoRoot, "target/release/bibcode"),
    NodePath.resolve(repoRoot, "target/release/bibcode.exe"),
  ].filter((path) => NodeFS.existsSync(path));
  if (serverCandidates.length !== 1) {
    throw new Error("Expected exactly one release server binary to scan.");
  }
  assertNoLegacyCloudArtifacts(repoRoot, [...webArtifacts, ...serverCandidates]);
  log(`Scanned ${webArtifacts.length} web artifacts and one server binary.`);
}

export function makeReleaseSmokeRuntime(
  childProcess: Pick<typeof NodeChildProcess, "execFileSync" | "spawnSync"> = NodeChildProcess,
): ReleaseSmokeRuntime {
  return {
    execFile(command, args, options) {
      const output = childProcess.execFileSync(command, [...args], options);
      return typeof output === "string" ? output : "";
    },
    spawn(command, args, options) {
      const result = childProcess.spawnSync(command, [...args], options);
      return {
        stdout: String(result.stdout),
        stderr: String(result.stderr),
        status: result.status,
        ...(result.error ? { error: result.error } : {}),
      };
    },
  };
}

const defaultRuntime = makeReleaseSmokeRuntime();

export function copyWorkspaceManifestFixture(sourceRoot: string, targetRoot: string): void {
  for (const relativePath of releaseSmokeWorkspaceFiles) {
    const sourcePath = NodePath.resolve(sourceRoot, relativePath);
    const destinationPath = NodePath.resolve(targetRoot, relativePath);
    NodeFS.mkdirSync(NodePath.dirname(destinationPath), { recursive: true });
    NodeFS.cpSync(sourcePath, destinationPath);
  }

  const patchesDirectory = NodePath.resolve(sourceRoot, "patches");
  if (NodeFS.existsSync(patchesDirectory)) {
    NodeFS.cpSync(patchesDirectory, NodePath.resolve(targetRoot, "patches"), { recursive: true });
  }
}

function assertContains(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) throw new Error(message);
}

function assertPackageVersion(filePath: string, version: string): void {
  const packageJson = JSON.parse(NodeFS.readFileSync(filePath, "utf8")) as {
    readonly version?: unknown;
  };
  if (packageJson.version !== version) {
    throw new Error(`Expected ${filePath} to have version ${version}.`);
  }
}

function assertCargoVersion(filePath: string, version: string, expectedOccurrences: number): void {
  const source = NodeFS.readFileSync(filePath, "utf8");
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const occurrences = source.match(
    new RegExp(`^version\\s*=\\s*"${escapedVersion}"\\s*$`, "gm"),
  )?.length;
  if (occurrences !== expectedOccurrences) {
    throw new Error(
      `Expected ${filePath} to contain ${expectedOccurrences} Cargo version entries for ${version}.`,
    );
  }
}

function writeFilteredInstallOutput(output: string, write: (text: string) => void): void {
  const filteredOutput = output
    .split(/\r?\n/)
    .filter((line) => !line.includes("deprecated subdependencies found"))
    .join("\n");
  if (filteredOutput.trim() !== "") {
    write(`${filteredOutput.replace(/\n+$/, "")}\n`);
  }
}

function runLockfileInstall(
  targetRoot: string,
  runtime: ReleaseSmokeRuntime,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): void {
  const result = runtime.spawn("vp", ["install", "--lockfile-only", "--ignore-scripts"], {
    cwd: targetRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  writeFilteredInstallOutput(result.stdout, stdout);
  writeFilteredInstallOutput(result.stderr, stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error("Command failed: vp install --lockfile-only --ignore-scripts");
  }
}

export function runReleaseSmoke(options: ReleaseSmokeOptions): void {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const tempRoot =
    options.tempRoot ??
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-release-smoke-"));
  const runtime = options.runtime;
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const log = options.log ?? ((text: string) => process.stdout.write(`${text}\n`));

  try {
    assertNoLegacyCloudDependencies(repoRoot);
    if (options.verifyBuiltArtifacts ?? true) {
      buildAndVerifyLegacyCloudFreeArtifacts(repoRoot, runtime, log);
    }
    copyWorkspaceManifestFixture(repoRoot, tempRoot);
    runtime.execFile(
      process.execPath,
      [
        NodePath.resolve(repoRoot, "scripts/update-release-package-versions.ts"),
        releaseSmokeVersion,
        "--root",
        tempRoot,
      ],
      { cwd: repoRoot, stdio: "inherit" },
    );

    NodeFS.rmSync(NodePath.resolve(tempRoot, "pnpm-lock.yaml"), { force: true });
    runLockfileInstall(tempRoot, runtime, stdout, stderr);
    const lockfile = NodeFS.readFileSync(NodePath.resolve(tempRoot, "pnpm-lock.yaml"), "utf8");
    assertContains(lockfile, "lockfileVersion:", "Expected pnpm-lock.yaml to be regenerated.");

    for (const relativePath of [
      "apps/server/package.json",
      "apps/desktop/package.json",
      "apps/web/package.json",
      "packages/contracts/package.json",
    ]) {
      assertPackageVersion(NodePath.resolve(tempRoot, relativePath), releaseSmokeVersion);
    }
    for (const relativePath of releaseRustPackageFiles) {
      assertCargoVersion(NodePath.resolve(tempRoot, relativePath), releaseSmokeVersion, 1);
    }
    assertCargoVersion(
      NodePath.resolve(tempRoot, releaseCargoLockFile),
      releaseSmokeVersion,
      releaseRustPackageFiles.length,
    );

    const nightlyReleaseMetadata = runtime.execFile(
      process.execPath,
      [
        NodePath.resolve(repoRoot, "scripts/resolve-nightly-release.ts"),
        "--date",
        "20260413",
        "--run-number",
        "321",
        "--sha",
        "abcdef1234567890",
        "--root",
        tempRoot,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assertContains(
      nightlyReleaseMetadata,
      "version=9.9.10-nightly.20260413.321",
      "Expected nightly metadata to contain the derived nightly version.",
    );
    assertContains(
      nightlyReleaseMetadata,
      "tag=v9.9.10-nightly.20260413.321",
      "Expected nightly metadata to contain the derived nightly tag.",
    );
    assertContains(
      nightlyReleaseMetadata,
      "name=BiBCode Nightly 9.9.10-nightly.20260413.321 (abcdef123456)",
      "Expected nightly metadata to include the short commit SHA in the release name.",
    );

    log("Release smoke checks passed.");
  } finally {
    NodeFS.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function runReleaseSmokeMain(isMain: boolean, options: ReleaseSmokeOptions): boolean {
  if (!isMain) return false;
  runReleaseSmoke(options);
  return true;
}

runReleaseSmokeMain(import.meta.main, { runtime: defaultRuntime });
