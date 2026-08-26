// @effect-diagnostics nodeBuiltinImport:off - Policy tests inspect checked-in source.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

const root = NodePath.resolve(import.meta.dirname, "..");
const scannerPath = "scripts/legacy-cloud-removal-contract.test.ts";
const historicalPrefixes = ["docs/plans/", "docs/superpowers/", ".repos/"] as const;
const exactAllowedPaths = new Set([
  scannerPath,
  "docs/dependency-upgrades/2026-07-17-ledger.json",
  "docs/operations/legacy-cloud-decommission.md",
]);
const boundedLegacyDecoderPaths = new Set([
  "apps/web/src/connection/catalogMigration.ts",
  "apps/web/src/connection/catalogMigration.test.ts",
]);

const forbiddenPatterns = [
  "BiBCode Connect",
  "bibcode-connect",
  "connect_mcp",
  "ConnectMcp",
  "RelayConnectionTarget",
  "RelayConnectionRegistration",
  "ManagedRelay",
  "managed_endpoint",
  "ManagedEndpoint",
  "cloudflared",
  "BIBCODE_RELAY",
  "VITE_BIBCODE_RELAY",
  "BIBCODE_CLERK",
  "VITE_CLERK",
  "@clerk/",
  "SCOPE_RELAY",
  "AuthRelay",
  "/api/connect",
  "cloud.getRelayClientStatus",
  "cloud.installRelayClient",
  "infra/relay",
] as const;

function isAllowedPath(path: string): boolean {
  return (
    exactAllowedPaths.has(path) || historicalPrefixes.some((prefix) => path.startsWith(prefix))
  );
}

function isBoundedLegacyDecoderLine(path: string, line: string): boolean {
  if (!boundedLegacyDecoderPaths.has(path)) return false;
  return line.includes("RelayConnectionTarget") && !line.includes("RelayConnectionRegistration");
}

function trackedFiles(): ReadonlyArray<string> {
  return NodeChildProcess.execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

function sourceViolations(): ReadonlyArray<string> {
  const violations: string[] = [];
  for (const relativePath of trackedFiles()) {
    if (isAllowedPath(relativePath)) continue;
    const absolutePath = NodePath.join(root, relativePath);
    if (!NodeFS.existsSync(absolutePath)) continue;
    if (!NodeFS.statSync(absolutePath).isFile()) continue;
    const source = NodeFS.readFileSync(absolutePath, "utf8");
    if (source.includes("\0")) continue;
    for (const [index, line] of source.split(/\r?\n/u).entries()) {
      for (const pattern of forbiddenPatterns) {
        if (!line.toLocaleLowerCase("en-US").includes(pattern.toLocaleLowerCase("en-US"))) {
          continue;
        }
        if (isBoundedLegacyDecoderLine(relativePath, line)) continue;
        violations.push(`${relativePath}:${index + 1}: ${pattern}`);
      }
    }
  }
  return violations;
}

describe("legacy cloud removal contract", () => {
  it("contains no active BiBCode Connect product surface", () => {
    expect(sourceViolations()).toEqual([]);
  });

  it("keeps the allowlist narrow and explicit", () => {
    expect([...historicalPrefixes]).toEqual(["docs/plans/", "docs/superpowers/", ".repos/"]);
    expect([...exactAllowedPaths].sort()).toEqual(
      [
        scannerPath,
        "docs/dependency-upgrades/2026-07-17-ledger.json",
        "docs/operations/legacy-cloud-decommission.md",
      ].sort(),
    );
    expect([...boundedLegacyDecoderPaths].sort()).toEqual(
      [
        "apps/web/src/connection/catalogMigration.ts",
        "apps/web/src/connection/catalogMigration.test.ts",
      ].sort(),
    );
  });

  it("keeps native installer validation inside the active-source scan", () => {
    for (const path of [
      ".github/workflows/server-native-smoke.yml",
      "apps/server/tests/packaged_server_smoke.rs",
      "scripts/create-server-install-smoke-set.ts",
      "scripts/lib/server-install-smoke-driver.ts",
      "scripts/server-install-smoke.ts",
    ]) {
      expect(isAllowedPath(path), path).toBe(false);
    }
  });
});
