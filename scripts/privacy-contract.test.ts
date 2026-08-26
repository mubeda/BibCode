// @effect-diagnostics nodeBuiltinImport:off - Privacy tests inspect checked-in source.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

const root = NodePath.resolve(import.meta.dirname, "..");
const ignoredDirectoryNames = new Set([
  ".alchemy",
  ".repos",
  ".vite-plus",
  "coverage",
  "dist",
  "fixtures",
  "node_modules",
  "target",
]);
const sourceExtensions = new Set([
  ".astro",
  ".bat",
  ".cjs",
  ".cmd",
  ".css",
  ".env",
  ".fish",
  ".html",
  ".js",
  ".json",
  ".mjs",
  ".ps1",
  ".rs",
  ".sh",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
  ".zsh",
]);
const executableSourceNames = new Set(["Dockerfile", "Makefile"]);
const forbiddenTelemetryMarkers = [
  "api.axiom.co",
  "otel.alchemy.run",
  "telemetry.astro.build",
  "sendBeacon",
  "alchemy/Axiom",
  "TelemetryLive",
  "google.com/s2/favicons",
  ["BIBCODE", "RELAY_CLIENT_OTLP"].join("_"),
  "BIBCODE_MOBILE_OTLP",
  "VITE_RELAY_OTLP",
  "OTEL_EXPORTER_OTLP",
  "/api/observability/v1/traces",
  "otlpTracesUrl",
  "otlpMetricsUrl",
  "@bibcode/shared/relayTracing",
];

function isSourceFile(name: string): boolean {
  return (
    name.startsWith(".env") ||
    executableSourceNames.has(name) ||
    sourceExtensions.has(NodePath.extname(name))
  );
}

function sourceFiles(path: string): string[] {
  return NodeFS.readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = NodePath.join(path, entry.name);
    if (entry.isDirectory()) {
      return ignoredDirectoryNames.has(entry.name) ? [] : sourceFiles(child);
    }
    if (entry.name.includes(".test.") || entry.name.includes(".spec.")) return [];
    return isSourceFile(entry.name) ? [child] : [];
  });
}

function privacySourceFiles(repoRoot: string): Array<string> {
  const trees = [
    ".devcontainer",
    ".github",
    ".vscode",
    "apps",
    "infra",
    "oxlint-plugin-bibcode",
    "packages",
    "scripts",
    "tools",
  ];
  const rootFiles = NodeFS.readdirSync(repoRoot, { withFileTypes: true }).flatMap((entry) =>
    entry.isFile() && isSourceFile(entry.name) && !entry.name.endsWith(".lock")
      ? [NodePath.join(repoRoot, entry.name)]
      : [],
  );
  return [
    ...trees.flatMap((tree) => {
      const path = NodePath.join(repoRoot, tree);
      return NodeFS.existsSync(path) ? sourceFiles(path) : [];
    }),
    ...rootFiles,
  ];
}

function read(path: string): string {
  return NodeFS.readFileSync(NodePath.join(root, path), "utf8");
}

function telemetryViolations(
  files: ReadonlyArray<string>,
  relativeTo: string = root,
): Array<string> {
  return files.flatMap((file) => {
    const source = NodeFS.readFileSync(file, "utf8");
    return forbiddenTelemetryMarkers
      .filter((marker) => source.includes(marker))
      .map((marker) => `${NodePath.relative(relativeTo, file)}: ${marker}`);
  });
}

describe("zero-telemetry privacy contract", () => {
  it("scans executable web, manifest, shell, and environment files", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-privacy-"));
    const fixtures = [
      "page.astro",
      "index.html",
      "package.json",
      "deploy.sh",
      "deploy.ps1",
      "deploy.cmd",
      ".env.production",
    ];
    try {
      for (const fixture of fixtures) {
        NodeFS.writeFileSync(NodePath.join(directory, fixture), "navigator.sendBeacon('/stats')");
      }

      expect(telemetryViolations(sourceFiles(directory), directory).sort()).toEqual(
        fixtures.map((fixture) => `${fixture}: sendBeacon`).sort(),
      );
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("contains no first-party remote telemetry path", () => {
    const violations = telemetryViolations(privacySourceFiles(root));

    expect(violations).toEqual([]);
  });

  it("removes dedicated telemetry modules", () => {
    for (const path of [
      "apps/server/src/telemetry/mod.rs",
      "apps/web/src/observability/clientTracing.ts",
      "packages/shared/src/relayTracing.ts",
    ]) {
      expect(NodeFS.existsSync(NodePath.join(root, path)), path).toBe(false);
    }
  });

  it("forces third-party telemetry off at repository entry points", () => {
    const marketing = JSON.parse(read("apps/marketing/package.json")) as {
      scripts: Record<string, string>;
    };
    const preload = "node --require ../../scripts/disable-telemetry.cjs";

    expect(Object.values(marketing.scripts).every((script) => script.startsWith(preload))).toBe(
      true,
    );

    const child = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--require",
        NodePath.join(root, "scripts/disable-telemetry.cjs"),
        "-e",
        `
        const attempt = (change) => { try { change(); } catch {} };
        attempt(() => { process.env.ASTRO_TELEMETRY_DISABLED = "0"; });
        attempt(() => Object.defineProperty(process.env, "DO_NOT_TRACK", { value: "0" }));
        attempt(() => { process.env.astro_telemetry_disabled = "0"; });
        attempt(() => Object.defineProperty(process.env, "do_not_track", { value: "0" }));
        attempt(() => { process.env = {}; });
        process.stdout.write(JSON.stringify({
          astro: process.env.ASTRO_TELEMETRY_DISABLED,
          doNotTrack: process.env.DO_NOT_TRACK,
        }));
      `,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ASTRO_TELEMETRY_DISABLED: "0",
          DO_NOT_TRACK: "0",
        },
      },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      astro: "1",
      doNotTrack: "1",
    });
  });

  it("preserves local diagnostics and stable automatic updates", () => {
    expect(NodeFS.existsSync(NodePath.join(root, "apps/server/src/diagnostics/trace.rs"))).toBe(
      true,
    );
    const updates = read("apps/desktop/src-tauri/src/updates.rs");
    const desktop = read("apps/desktop/src-tauri/src/lib.rs");
    expect(updates).toContain(
      "BACKGROUND_UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(30 * 60)",
    );
    expect(desktop).toContain("run_background_update_checks");
    expect(read("apps/desktop/src-tauri/tauri.release.conf.json")).toContain(
      "releases/latest/download/latest.json",
    );
  });

  it("keeps ordinary startup behind the deny-by-default outbound regression", () => {
    const scheduler = read("apps/server/src/production/control.rs");
    const outboundRegression = read("apps/server/tests/no_unexpected_outbound.rs");
    const releaseSmoke = read("scripts/release-smoke.ts");

    expect(scheduler).toContain("interval_at(Instant::now() + period, period)");
    expect(scheduler).not.toContain("tokio::time::interval(Duration::from_secs(60 * 60))");
    for (const scenario of ["cold_start", "local_use", "pairing", "diagnostics", "crash"]) {
      expect(outboundRegression).toContain(scenario);
    }
    for (const proxyVariable of ["ALL_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) {
      expect(outboundRegression).toContain(proxyVariable);
    }
    expect(outboundRegression).toContain("Vec::<String>::new()");
    expect(releaseSmoke).toContain("assertNoLegacyCloudArtifacts");
    expect(releaseSmoke).toContain('"--release"');
  });
});
