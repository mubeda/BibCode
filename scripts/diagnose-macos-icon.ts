// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { HostProcessPlatform } from "@bibcode/shared/hostProcess";
import * as Effect from "effect/Effect";

import {
  runBoundedCommand,
  SeededUpgradeCommandTimeoutError,
} from "./seeded-desktop-upgrade-smoke.ts";

const STAGES = new Set([
  "swift-entry",
  "application-init-dispatched",
  "application-init-returned",
  "file-check-succeeded",
  "workspace-dispatched",
  "workspace-returned",
  "workspace-shared-dispatched",
  "workspace-shared-returned",
  "icon-lookup-dispatched",
  "icon-lookup-returned",
  "image-size-dispatched",
  "image-size-returned",
  "bitmap-dispatched",
  "bitmap-returned",
  "context-dispatched",
  "context-returned",
  "draw-dispatched",
  "draw-returned",
  "pixel-scan-dispatched",
  "pixel-scan-returned",
  "verdict-rejected",
  "verdict-accepted",
]);

interface Observation {
  readonly stage: string;
  readonly width?: number;
  readonly height?: number;
  readonly opaque?: number;
  readonly dark?: number;
  readonly pale?: number;
  readonly countsCapped?: boolean;
  readonly dimensionsCapped?: boolean;
}

export function decodeMacIconObservations(raw: string): ReadonlyArray<Observation> {
  if (Buffer.byteLength(raw) > 65_536) throw new Error("ICON_OBSERVATION_BOUND");
  const rows = raw.split("\n").filter((line) => line.length !== 0);
  if (rows.length > 64) throw new Error("ICON_OBSERVATION_COUNT");
  return rows.map((line) => {
    const value: unknown = JSON.parse(line);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("ICON_OBSERVATION_SHAPE");
    }
    const record = value as Record<string, unknown>;
    if (typeof record.stage !== "string" || !STAGES.has(record.stage)) {
      throw new Error("ICON_OBSERVATION_STAGE");
    }
    const result: Record<string, string | number | boolean> = { stage: record.stage };
    for (const field of ["width", "height", "opaque", "dark", "pale"] as const) {
      if (record[field] === undefined) continue;
      const cap = field === "width" || field === "height" ? 16_384 : 1_048_576;
      if (
        !Number.isSafeInteger(record[field]) ||
        (record[field] as number) < 0 ||
        (record[field] as number) > cap
      ) {
        throw new Error("ICON_OBSERVATION_VALUE");
      }
      result[field] = record[field] as number;
    }
    for (const field of ["countsCapped", "dimensionsCapped"] as const) {
      if (record[field] === undefined) continue;
      if (typeof record[field] !== "boolean") throw new Error("ICON_OBSERVATION_VALUE");
      result[field] = record[field];
    }
    return result as unknown as Observation;
  });
}

type Arm = "CONTROL" | "SHARED_INIT" | "CONTROL_REPEAT" | "RECT_ONLY";
type Outcome = "ACCEPTED" | "REJECTED" | "TIMED_OUT" | "EXIT_WITHOUT_VERDICT" | "LOOKUP_RETURNED";
type Execute = typeof runBoundedCommand;

interface ProbeResult {
  readonly arm: Arm;
  readonly phase: "FIXTURES" | "PAYLOAD" | "LOOKUP";
  readonly outcome: Outcome;
  readonly exitCode: number | null;
  readonly closeVerified: true;
  readonly elapsedMs: number;
  readonly observations: ReadonlyArray<Observation>;
  readonly stdoutSHA256: string | null;
  readonly stderrSHA256: string | null;
}

export async function runMacIconExperiment(input: {
  readonly appPath: string;
  readonly scriptPath: string;
  readonly evidenceRoot: string;
  readonly cwd: string;
  readonly execute?: Execute;
  readonly singleArm?: "CONTROL" | "SHARED_INIT" | undefined;
  readonly lookupOnly?: boolean | undefined;
}): Promise<ReadonlyArray<ProbeResult>> {
  if (input.execute === undefined) {
    requireMacIconDiagnosticCI(process.env, Effect.runSync(HostProcessPlatform));
  }
  const execute = input.execute ?? runBoundedCommand;
  if (input.lookupOnly && input.singleArm === undefined)
    throw new Error("ICON_LOOKUP_SINGLE_ARM_REQUIRED");
  const safePath = NodePath.join(input.evidenceRoot, "cleanup-safe");
  const results: Array<ProbeResult> = [];
  await NodeFSP.mkdir(input.evidenceRoot, { recursive: true, mode: 0o700 });

  const probe = async (arm: Arm, phase: ProbeResult["phase"]): Promise<ProbeResult> => {
    const receiptPath = NodePath.join(input.evidenceRoot, `${arm}-${phase}.private.jsonl`);
    await NodeFSP.writeFile(receiptPath, "", { flag: "wx", mode: 0o600 });
    await NodeFSP.rm(safePath, { force: true });
    const started = performance.now();
    let outcome: Outcome;
    let exitCode: number | null = null;
    let stdoutSHA256: string | null = null;
    let stderrSHA256: string | null = null;
    try {
      const result = await execute({
        command: "swift",
        args: [input.scriptPath, phase === "FIXTURES" ? "--self-test" : input.appPath],
        cwd: input.cwd,
        env: {
          ...process.env,
          MAC_ICON_DIAGNOSTIC_RECORDS_PATH: receiptPath,
          MAC_ICON_DIAGNOSTIC_INITIALIZE_APPLICATION: arm === "SHARED_INIT" ? "1" : "0",
          MAC_ICON_DIAGNOSTIC_RECT_ONLY: arm === "RECT_ONLY" ? "1" : "0",
          MAC_ICON_DIAGNOSTIC_LOOKUP_ONLY: phase === "LOOKUP" ? "1" : "0",
        },
        timeoutMs: 120_000,
      });
      // The shared owner resolves only on close, including its output pipes.
      await NodeFSP.writeFile(safePath, "closed\n", { mode: 0o600 });
      exitCode = result.exitCode;
      stdoutSHA256 = NodeCrypto.createHash("sha256").update(result.stdout).digest("hex");
      stderrSHA256 = NodeCrypto.createHash("sha256").update(result.stderr).digest("hex");
      outcome = result.exitCode === 0 ? "EXIT_WITHOUT_VERDICT" : "REJECTED";
      if (
        phase === "FIXTURES" &&
        result.exitCode === 0 &&
        result.stdout.includes("PASS: Finder icon raster fixtures")
      ) {
        outcome = "ACCEPTED";
      }
    } catch (cause) {
      if (!(cause instanceof SeededUpgradeCommandTimeoutError))
        throw new Error("ICON_PROBE_OWNER_FAILED");
      // This typed timeout can exist only after positively verified close.
      await NodeFSP.writeFile(safePath, "closed\n", { mode: 0o600 });
      outcome = "TIMED_OUT";
    }
    const observations = decodeMacIconObservations(await NodeFSP.readFile(receiptPath, "utf8"));
    if (
      phase === "LOOKUP" &&
      exitCode === 0 &&
      observations.some((row) => row.stage === "workspace-shared-returned") &&
      observations.some((row) => row.stage === "icon-lookup-returned")
    ) {
      outcome = "LOOKUP_RETURNED";
    }
    if (
      phase === "PAYLOAD" &&
      exitCode === 0 &&
      observations.some((row) => row.stage === "verdict-accepted")
    ) {
      outcome = "ACCEPTED";
    }
    const result: ProbeResult = {
      arm,
      phase,
      outcome,
      exitCode,
      closeVerified: true,
      elapsedMs: Math.min(180_000, Math.round(performance.now() - started)),
      observations,
      stdoutSHA256,
      stderrSHA256,
    };
    results.push(result);
    await NodeFSP.writeFile(
      NodePath.join(input.evidenceRoot, "observations.json"),
      JSON.stringify(
        {
          diagnosticOnly: true,
          releaseQualified: false,
          results,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    process.stdout.write(JSON.stringify(result) + "\n");
    return result;
  };

  const runArm = async (arm: Arm): Promise<ProbeResult> => {
    const fixtures = await probe(arm, "FIXTURES");
    return fixtures.outcome === "ACCEPTED"
      ? probe(arm, input.lookupOnly ? "LOOKUP" : "PAYLOAD")
      : fixtures;
  };
  if (input.singleArm !== undefined) {
    await runArm(input.singleArm);
    return results;
  }
  const control = await runArm("CONTROL");
  const treatment = await runArm("SHARED_INIT");
  const pairedPayloads = control.phase === "PAYLOAD" && treatment.phase === "PAYLOAD";
  if (pairedPayloads && control.outcome === "TIMED_OUT" && treatment.outcome !== "TIMED_OUT") {
    await runArm("CONTROL_REPEAT");
  } else if (
    pairedPayloads &&
    control.outcome === "TIMED_OUT" &&
    treatment.outcome === "TIMED_OUT"
  ) {
    await runArm("RECT_ONLY");
  }
  return results;
}

export function requireMacIconDiagnosticCI(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): void {
  if (env.CI !== "true" || env.GITHUB_ACTIONS !== "true" || platform !== "darwin") {
    throw new Error("ICON_DIAGNOSTIC_CI_ONLY");
  }
}

if (
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  try {
    requireMacIconDiagnosticCI(process.env, Effect.runSync(HostProcessPlatform));
    if (process.argv.length !== 5) throw new Error("ICON_DIAGNOSTIC_ARGUMENTS");
    const singleArm = process.env.MAC_ICON_DIAGNOSTIC_SINGLE_ARM;
    if (singleArm !== undefined && singleArm !== "CONTROL" && singleArm !== "SHARED_INIT") {
      throw new Error("ICON_DIAGNOSTIC_ARGUMENTS");
    }
    await runMacIconExperiment({
      scriptPath: NodePath.resolve(process.argv[2]!),
      appPath: NodePath.resolve(process.argv[3]!),
      evidenceRoot: NodePath.resolve(process.argv[4]!),
      cwd: process.cwd(),
      singleArm,
      lookupOnly: process.env.MAC_ICON_DIAGNOSTIC_LOOKUP_ONLY === "1",
    });
  } catch {
    process.stderr.write("ICON_DIAGNOSTIC_FAILED\n");
    process.exitCode = 1;
  }
}
