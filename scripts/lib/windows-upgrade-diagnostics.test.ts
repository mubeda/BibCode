// @effect-diagnostics nodeBuiltinImport:off - These tests own temporary native diagnostic fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { HostProcessPlatform } from "@bibcode/shared/hostProcess";
import * as Context from "effect/Context";
import {
  safeWindowsDiagnosticRecord,
  writeWindowsDiagnosticRecord,
  withWindowsDiagnosticObserver,
  recordWindowsBuildVersion,
  WINDOWS_DIAGNOSTIC_MAX_BYTES,
} from "./windows-upgrade-diagnostics.ts";
import { prepareSeededUpgradeBuild } from "../seeded-desktop-upgrade-smoke.ts";
import { releaseVersionFiles } from "../update-release-package-versions.ts";

const repositoryRoot = NodePath.resolve(NodeURL.fileURLToPath(new URL("../..", import.meta.url)));
const nativePlatform = Context.get(Context.empty(), HostProcessPlatform);

describe("Windows upgrade diagnostics", () => {
  it("records verified build versions after pinning without replacing source patch provenance", async () => {
    const root = await NodeFS.promises.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "windows-version-provenance-"),
    );
    try {
      const checkout = NodePath.join(root, "checkout");
      for (const path of releaseVersionFiles) {
        await NodeFS.promises.mkdir(NodePath.dirname(NodePath.join(checkout, path)), {
          recursive: true,
        });
        await NodeFS.promises.copyFile(
          NodePath.join(repositoryRoot, path),
          NodePath.join(checkout, path),
        );
      }
      const evidenceDirectory = NodePath.join(root, "evidence");
      await NodeFS.promises.mkdir(evidenceDirectory);
      const provenancePath = NodePath.join(evidenceDirectory, "windows-source-provenance.json");
      const source = {
        sourceKind: "instrumented-source-rebuild",
        patchSha256: "fixture-patch-hash",
        instrumentedSources: [{ path: "fixture.rs", sha256: "fixture-instrumented-hash" }],
      };
      await NodeFS.promises.writeFile(provenancePath, JSON.stringify(source));
      const overlayPath = NodePath.join(root, "overlay.json");
      const version = "1.2.3";
      await NodeFS.promises.writeFile(overlayPath, JSON.stringify({ version }));
      await prepareSeededUpgradeBuild({ repositoryRoot, checkout, overlayPath, version });
      expect(recordWindowsBuildVersion({ checkout, evidenceDirectory, version })).toBe(true);
      const provenance = JSON.parse(await NodeFS.promises.readFile(provenancePath, "utf8"));
      expect(provenance).toMatchObject({ ...source, buildVersion: version });
      expect(provenance.versionFiles).toEqual(
        await Promise.all(
          releaseVersionFiles.map(async (path) => ({
            path,
            sha256: NodeCrypto.createHash("sha256")
              .update(await NodeFS.promises.readFile(NodePath.join(checkout, path)))
              .digest("hex"),
          })),
        ),
      );
      expect(recordWindowsBuildVersion({ checkout, evidenceDirectory: root, version })).toBe(false);
      const retained = await NodeFS.promises.readFile(provenancePath, "utf8");
      await NodeFS.promises.mkdir(`${provenancePath}.version.tmp`);
      expect(recordWindowsBuildVersion({ checkout, evidenceDirectory, version })).toBe(false);
      expect(await NodeFS.promises.readFile(provenancePath, "utf8")).toBe(retained);
    } finally {
      await NodeFS.promises.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps only bounded attributable process evidence and drops ambient secrets", () => {
    expect(
      safeWindowsDiagnosticRecord({
        kind: "process-stop",
        at: "2026-10-02T09:00:00Z",
        pid: 21,
        parentPid: 17,
        role: "application",
        verified: true,
        exitStatus: 3221225477,
        path: "C:\\isolated\\bibcode-desktop.exe",
        commandLine: "secret argument",
        token: "private",
      }),
    ).toEqual({
      kind: "process-stop",
      at: "2026-10-02T09:00:00Z",
      pid: 21,
      parentPid: 17,
      role: "application",
      verified: true,
      exitStatus: 3221225477,
      path: "C:\\isolated\\bibcode-desktop.exe",
    });
    expect(safeWindowsDiagnosticRecord({ kind: "unknown", message: "private" })).toBeNull();
    expect(safeWindowsDiagnosticRecord({ kind: "process-stop", pid: -1 })).toBeNull();
  });

  it("bounds retained evidence and ignores an unwritable diagnostic destination", async () => {
    const root = await NodeFS.promises.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "bibcode-windows-observation-"),
    );
    try {
      const path = NodePath.join(root, "events.jsonl");
      await NodeFS.promises.writeFile(path, " ".repeat(WINDOWS_DIAGNOSTIC_MAX_BYTES - 1024));
      expect(writeWindowsDiagnosticRecord(path, { kind: "observer-ready" })).toBe(false);
      expect(await NodeFS.promises.readFile(path, "utf8")).toContain('"kind":"observer-budget"');
      await NodeFS.promises.writeFile(path, " ".repeat(WINDOWS_DIAGNOSTIC_MAX_BYTES));
      expect(writeWindowsDiagnosticRecord(path, { kind: "observer-ready" })).toBe(false);
      expect((await NodeFS.promises.stat(path)).size).toBe(WINDOWS_DIAGNOSTIC_MAX_BYTES);
      expect(writeWindowsDiagnosticRecord(root, { kind: "observer-ready" })).toBe(false);
    } finally {
      await NodeFS.promises.rm(root, { recursive: true, force: true });
    }
  });

  it("never replaces an original failure or success with an observer failure", async () => {
    const original = new Error("original install failure");
    await expect(
      withWindowsDiagnosticObserver(
        async () => ({
          stop: async () => {
            throw new Error("observer stop");
          },
        }),
        async () => {
          throw original;
        },
      ),
    ).rejects.toBe(original);
    await expect(
      withWindowsDiagnosticObserver(
        async () => {
          throw new Error("observer start");
        },
        async () => 17,
      ),
    ).resolves.toBe(17);
    await expect(
      withWindowsDiagnosticObserver(
        async () => ({
          stop: async () => {
            throw new Error("observer stop");
          },
        }),
        async () => 19,
      ),
    ).resolves.toBe(19);
  });

  it("native marker write failures leave the original result intact", async () => {
    const root = await NodeFS.promises.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "bibcode-native-marker-"),
    );
    try {
      await NodeFS.promises.copyFile(
        NodePath.join(repositoryRoot, "scripts/fixtures/windows-upgrade-marker.rs"),
        NodePath.join(root, "marker.rs"),
      );
      await NodeFS.promises.writeFile(
        NodePath.join(root, "main.rs"),
        `
include!("marker.rs");
fn main() {
    let path = std::env::args().nth(1).expect("test-owned destination");
    seeded_upgrade_marker("install-entered");
    let original: Result<u32, &str> = Err("original");
    seeded_upgrade_write_marker(std::path::Path::new(&path), "install-admitted");
    assert_eq!(original, Err("original"));
}
`,
      );
      const binary = NodePath.join(root, nativePlatform === "win32" ? "marker.exe" : "marker");
      const version = NodeChildProcess.spawnSync("rustc", ["-vV"], {
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(version.status, version.stderr).toBe(0);
      const host = /^host: ([A-Za-z0-9_-]+)$/m.exec(version.stdout)?.[1];
      if (!host) throw new Error("The native Rust compiler did not report its host target.");
      const compiled = NodeChildProcess.spawnSync(
        process.execPath,
        [
          NodePath.join(repositoryRoot, "scripts/run-msvc.mjs"),
          "rustc",
          "--target",
          host,
          "--edition=2024",
          "-Dwarnings",
          NodePath.join(root, "main.rs"),
          "-o",
          binary,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(compiled.status, compiled.stderr).toBe(0);
      const env = { ...process.env, BIBCODE_SEEDED_WINDOWS_DIAGNOSTICS: "0" };
      expect(NodeChildProcess.spawnSync(binary, [root], { timeout: 10_000, env }).status).toBe(0);
      const output = NodePath.join(root, "markers.jsonl");
      expect(NodeChildProcess.spawnSync(binary, [output], { timeout: 10_000, env }).status).toBe(0);
      expect(JSON.parse(await NodeFS.promises.readFile(output, "utf8"))).toMatchObject({
        kind: "native-marker",
        boundary: "install-admitted",
      });
      const capped = NodePath.join(root, "capped.log");
      await NodeFS.promises.writeFile(capped, " ".repeat(55 * 1024 + 1));
      expect(NodeChildProcess.spawnSync(binary, [capped], { timeout: 10_000, env }).status).toBe(0);
      expect(JSON.parse(await NodeFS.promises.readFile(capped, "utf8"))).toEqual({
        kind: "native-marker-budget",
      });
      expect((await NodeFS.promises.stat(capped)).size).toBeLessThan(56 * 1024);
    } finally {
      await NodeFS.promises.rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it.skipIf(nativePlatform !== "win32")(
    "projects native Application/WER fixtures without accessing the host logs",
    async () => {
      const root = await NodeFS.promises.mkdtemp(
        NodePath.join(NodeOS.tmpdir(), "bibcode-wer-fixture-"),
      );
      try {
        const reportId = "cfd97016-ec13-48dd-a72b-06e51bc32679";
        const applicationPath = "C:\\fixture\\bibcode-desktop.exe";
        const event = (provider: string, id: number, data: Record<string, string>) =>
          `<Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event"><System><Provider Name="${provider}"/><EventID Qualifiers="0">${id}</EventID><EventRecordID>12</EventRecordID><TimeCreated SystemTime="2026-10-02T09:00:00Z"/></System><EventData>${Object.entries(
            data,
          )
            .map(([name, value]) => `<Data Name="${name}">${value}</Data>`)
            .join("")}</EventData></Event>`;
        const fixturePath = NodePath.join(root, "input.json");
        await NodeFS.promises.writeFile(
          fixturePath,
          JSON.stringify({
            applicationPath,
            events: [
              event("Application Error", 1000, {
                AppPath: applicationPath,
                AppVersion: "0.7.2",
                ExceptionCode: "c0000005",
                ModuleName: "KERNELBASE.dll",
                IntegratorReportId: reportId,
                Secret: "private-never-retain",
              }),
              event("Application Error", 1000, {
                AppPath: "C:\\other\\bibcode-desktop.exe",
                ExceptionCode: "c0000005",
              }),
              event("Windows Error Reporting", 1001, {
                ReportId: reportId,
                EventName: "APPCRASH",
                AttachedFiles: "private-never-retain",
              }),
              event("Windows Error Reporting", 1001, {
                ReportId: "00000000-0000-0000-0000-000000000000",
                EventName: "APPCRASH",
              }),
            ],
          }),
        );
        const result = NodeChildProcess.spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-File",
            NodePath.join(repositoryRoot, "scripts/fixtures/windows-upgrade-observer.ps1"),
            "-FixturePath",
            fixturePath,
          ],
          { encoding: "utf8", timeout: 10_000 },
        );
        expect(result.status, result.stderr).toBe(0);
        const records = result.stdout
          .trim()
          .split(/\r?\n/)
          .map((line) => JSON.parse(line));
        expect(records).toHaveLength(2);
        expect(records[0]).toMatchObject({
          kind: "application-error",
          exceptionCode: "c0000005",
          path: applicationPath,
        });
        expect(records[1]).toMatchObject({ kind: "wer-report", reportId });
        expect(result.stdout).not.toContain("private-never-retain");
      } finally {
        await NodeFS.promises.rm(root, { recursive: true, force: true });
      }
    },
  );
});
