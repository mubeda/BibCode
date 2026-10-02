// @effect-diagnostics nodeBuiltinImport:off - CI diagnostics own explicit native processes and evidence paths.
// @effect-diagnostics globalTimers:off - Observer startup and shutdown are bounded independently of updates.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import { HostProcessPlatform } from "@bibcode/shared/hostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { releaseVersionFiles } from "../update-release-package-versions.ts";

export const WINDOWS_DIAGNOSTIC_MAX_BYTES = 56 * 1024;
const BoundedText = Schema.String.check(Schema.isMaxLength(1024));
const Unsigned = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4_294_967_295 }));
const DiagnosticRecord = Schema.Struct({
  kind: Schema.Literals([
    "observer-starting",
    "observer-ready",
    "observer-partial-ready",
    "observer-unavailable",
    "observer-error",
    "observer-exit",
    "observer-stopping",
    "observer-stopped",
    "observer-budget",
    "process-start",
    "process-stop",
    "process-unverified",
    "process-stop-unverified",
    "application-error",
    "wer-report",
    "eventlog-unavailable",
    "eventlog-none",
    "eventlog-unattributed",
    "eventlog-truncated",
    "controller",
    "probe-starting",
    "probe-complete",
    "probe-error",
  ]),
  at: Schema.optionalKey(BoundedText),
  pid: Schema.optionalKey(Unsigned),
  parentPid: Schema.optionalKey(Unsigned),
  role: Schema.optionalKey(Schema.Literals(["application", "installer"])),
  verified: Schema.optionalKey(Schema.Boolean),
  path: Schema.optionalKey(BoundedText),
  createdAt: Schema.optionalKey(BoundedText),
  exitStatus: Schema.optionalKey(Unsigned),
  exitHex: Schema.optionalKey(BoundedText),
  recordId: Schema.optionalKey(Schema.Int),
  appVersion: Schema.optionalKey(BoundedText),
  module: Schema.optionalKey(BoundedText),
  moduleVersion: Schema.optionalKey(BoundedText),
  exceptionCode: Schema.optionalKey(BoundedText),
  faultOffset: Schema.optionalKey(BoundedText),
  reportId: Schema.optionalKey(BoundedText),
  eventType: Schema.optionalKey(BoundedText),
  boundary: Schema.optionalKey(
    Schema.Literals([
      "seed-driver-start",
      "seed-driver-end",
      "handoff-start",
      "handoff-end",
      "observation-end",
    ]),
  ),
  reason: Schema.optionalKey(
    Schema.Literals([
      "spawn-error",
      "timeout",
      "nonzero-exit",
      "invalid-record",
      "provider-unavailable",
      "no-match",
      "cap-reached",
      "stop-failed",
    ]),
  ),
});
const decodeRecord = Schema.decodeUnknownOption(DiagnosticRecord);
const reportedBudgets = new Set<string>();
export type WindowsDiagnosticRecord = typeof DiagnosticRecord.Type;

export function safeWindowsDiagnosticRecord(input: unknown): WindowsDiagnosticRecord | null {
  const decoded = decodeRecord(input);
  return Option.isSome(decoded) ? decoded.value : null;
}

/** Diagnostic I/O is never part of the installation result. */
export function writeWindowsDiagnosticRecord(path: string, input: unknown): boolean {
  const record = safeWindowsDiagnosticRecord(input);
  if (record === null) return false;
  try {
    const at = DateTime.formatIso(
      DateTime.makeUnsafe(NodePerfHooks.performance.timeOrigin + NodePerfHooks.performance.now()),
    );
    const encoded = `${JSON.stringify({ at, ...record })}\n`;
    const size = NodeFS.existsSync(path) ? NodeFS.statSync(path).size : 0;
    const terminal = ["observer-exit", "observer-stopped", "observer-budget"].includes(record.kind);
    if (size + Buffer.byteLength(encoded) > WINDOWS_DIAGNOSTIC_MAX_BYTES - (terminal ? 0 : 1024)) {
      if (!terminal && !reportedBudgets.has(path)) {
        reportedBudgets.add(path);
        writeWindowsDiagnosticRecord(path, { kind: "observer-budget", reason: "cap-reached" });
      }
      return false;
    }
    NodeFS.appendFileSync(path, encoded, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export async function withWindowsDiagnosticObserver<A>(
  start: () => Promise<{ stop: () => Promise<void> }>,
  run: () => Promise<A>,
): Promise<A> {
  let observer: { stop: () => Promise<void> } | undefined;
  try {
    observer = await start();
  } catch {
    /* Evidence failure cannot replace the update. */
  }
  try {
    return await run();
  } finally {
    try {
      await observer?.stop();
    } catch {
      /* Preserve the original outcome. */
    }
  }
}

const sha256 = (bytes: string | Buffer): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** Called only for the two disposable baseline worktrees, before their builds. */
export function instrumentWindowsBaseline(input: {
  repositoryRoot: string;
  checkout: string;
  evidenceDirectory: string;
  sourceRef: string;
}): void {
  if (
    process.env.CI !== "true" ||
    Context.get(Context.empty(), HostProcessPlatform) !== "win32" ||
    NodeFS.realpathSync(input.checkout) === NodeFS.realpathSync(input.repositoryRoot)
  )
    throw new Error("Windows source diagnostics require a disposable CI baseline checkout.");
  const patchPath = NodePath.join(
    input.repositoryRoot,
    "scripts/fixtures/windows-upgrade-diagnostics.patch",
  );
  const markerPath = NodePath.join(
    input.repositoryRoot,
    "scripts/fixtures/windows-upgrade-marker.rs",
  );
  const sources = ["apps/desktop/src-tauri/src/updates.rs", "apps/server/src/maintenance.rs"];
  const git = (args: string[]): string =>
    NodeChildProcess.execFileSync("git", args, {
      cwd: input.checkout,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const sourceCommit = git(["rev-parse", "HEAD"]).trim();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit) || git(["status", "--porcelain"]).trim() !== "")
    throw new Error("Windows diagnostic baseline must be a clean committed checkout.");
  const before = sources.map((path) => ({
    path,
    sha256: sha256(NodeFS.readFileSync(NodePath.join(input.checkout, path))),
  }));
  try {
    git(["apply", "--check", patchPath]);
    git(["apply", patchPath]);
    for (const directory of ["apps/desktop/src-tauri/src", "apps/server/src"])
      NodeFS.copyFileSync(
        markerPath,
        NodePath.join(input.checkout, directory, "seeded_upgrade_diagnostics.rs"),
      );
  } catch {
    throw new Error(
      "The observational Windows source patch could not be applied; no baseline was built.",
    );
  }
  NodeFS.mkdirSync(input.evidenceDirectory, { recursive: true, mode: 0o700 });
  NodeFS.writeFileSync(
    NodePath.join(input.evidenceDirectory, "windows-source-provenance.json"),
    JSON.stringify({
      sourceKind: "instrumented-source-rebuild",
      sourceRef: input.sourceRef,
      sourceCommit,
      patchSha256: sha256(NodeFS.readFileSync(patchPath)),
      markerSha256: sha256(NodeFS.readFileSync(markerPath)),
      originalSources: before,
      instrumentedSources: sources.map((path) => ({
        path,
        sha256: sha256(NodeFS.readFileSync(NodePath.join(input.checkout, path))),
      })),
    }),
    { mode: 0o600 },
  );
}

/** Called only after the canonical helper and build-version assertions succeed. */
export function recordWindowsBuildVersion(input: {
  checkout: string;
  evidenceDirectory: string;
  version: string;
}): boolean {
  const path = NodePath.join(input.evidenceDirectory, "windows-source-provenance.json");
  const staged = `${path}.version.tmp`;
  try {
    const source = JSON.parse(NodeFS.readFileSync(path, "utf8"));
    NodeFS.writeFileSync(
      staged,
      JSON.stringify({
        ...source,
        buildVersion: input.version,
        versionFiles: releaseVersionFiles.map((relativePath) => ({
          path: relativePath,
          sha256: sha256(NodeFS.readFileSync(NodePath.join(input.checkout, relativePath))),
        })),
      }),
      { mode: 0o600 },
    );
    NodeFS.renameSync(staged, path);
    return true;
  } catch {
    return false;
  } finally {
    try {
      NodeFS.rmSync(staged, { force: true });
    } catch {
      /* Preserve the original outcome. */
    }
  }
}

export async function startWindowsUpgradeObserver(input: {
  repositoryRoot: string;
  evidenceDirectory: string;
  appBinaryPath: string;
  candidateVersion: string;
  timeoutMs: number;
}): Promise<{ stop: () => Promise<void> }> {
  const output = NodePath.join(input.evidenceDirectory, "windows-process-events.log");
  const stopPath = NodePath.join(input.evidenceDirectory, "windows-observer.stop");
  writeWindowsDiagnosticRecord(output, { kind: "observer-starting" });
  const child = NodeChildProcess.spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      NodePath.join(input.repositoryRoot, "scripts/fixtures/windows-upgrade-observer.ps1"),
      "-ApplicationPath",
      input.appBinaryPath,
      "-CandidateVersion",
      input.candidateVersion,
      "-StopPath",
      stopPath,
      "-TimeoutSeconds",
      String(Math.ceil(input.timeoutMs / 1000)),
    ],
    { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
  );
  let ready = false;
  let closed = false;
  let pending = "";
  let resolveReady: (() => void) | undefined;
  const readiness = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const exited = new Promise<void>((resolve) => {
    child.once("error", () => {
      writeWindowsDiagnosticRecord(output, { kind: "observer-unavailable", reason: "spawn-error" });
      resolveReady?.();
      if (child.pid === undefined) {
        closed = true;
        resolve();
      }
    });
    child.once("close", (code) => {
      closed = true;
      writeWindowsDiagnosticRecord(output, {
        kind: "observer-exit",
        ...(code === null ? {} : { exitStatus: code >>> 0 }),
      });
      resolveReady?.();
      resolve();
    });
  });
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    pending += chunk;
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try {
        const record = line.length <= 8192 ? safeWindowsDiagnosticRecord(JSON.parse(line)) : null;
        if (record !== null) {
          writeWindowsDiagnosticRecord(output, record);
          if (record.kind === "observer-ready" || record.kind === "observer-partial-ready") {
            ready = true;
            resolveReady?.();
          }
        } else
          writeWindowsDiagnosticRecord(output, {
            kind: "observer-error",
            reason: "invalid-record",
          });
      } catch {
        writeWindowsDiagnosticRecord(output, { kind: "observer-error", reason: "invalid-record" });
      }
    }
    if (pending.length > 8192) pending = "";
  });
  let readinessTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    readiness,
    new Promise<void>((resolve) => {
      readinessTimer = setTimeout(resolve, 10_000);
    }),
  ]);
  clearTimeout(readinessTimer);
  if (!ready)
    writeWindowsDiagnosticRecord(output, { kind: "observer-unavailable", reason: "timeout" });
  return {
    stop: async () => {
      writeWindowsDiagnosticRecord(output, { kind: "observer-stopping" });
      try {
        NodeFS.writeFileSync(stopPath, "stop", { mode: 0o600 });
      } catch {
        /* Own child is still bounded. */
      }
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      const forceTimer = setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, 8_000);
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          stopTimer = setTimeout(() => {
            writeWindowsDiagnosticRecord(output, { kind: "observer-error", reason: "stop-failed" });
            resolve();
          }, 10_000);
        }),
      ]);
      clearTimeout(stopTimer);
      clearTimeout(forceTimer);
      if (closed) writeWindowsDiagnosticRecord(output, { kind: "observer-stopped" });
      else {
        // A failed observer must not keep the original harness alive through its pipe/handle.
        child.stdout?.destroy();
        child.unref();
      }
    },
  };
}
