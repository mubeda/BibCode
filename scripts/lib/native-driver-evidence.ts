// @effect-diagnostics nodeBuiltinImport:off - The CI owner reads only its existing fixed private result through a pinned bounded handle.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

export const nativeDriverInnerPhases = [
  "admission",
  "native-menu-theme-light",
  "native-menu-theme-dark",
  "native-update-protection-light",
  "native-update-protection-dark",
  "native-update-recovery-light",
  "native-update-recovery-dark",
  "native-recovery-install-failure",
] as const;
export type NativeDriverInnerPhase = (typeof nativeDriverInnerPhases)[number];
export interface NativeDriverInnerFailure {
  readonly status: "unavailable";
  readonly reason: "native-observation-refused";
  readonly originalCount: number;
}
export interface NativeDriverInnerResult {
  readonly originalCount: number;
  readonly outstandingRowCount: number;
  readonly cleanup: "joined" | "unsafe";
  readonly partitionComplete: boolean;
  readonly sourceMatches: boolean;
}
export interface NativeDriverHandoff {
  readonly schemaVersion: 1;
  readonly selection: "release-visual-native-followups";
  readonly sourceSha: string;
  readonly partition: "linux-menu-update";
  readonly innerPhase: NativeDriverInnerPhase | null;
  readonly innerFailure: NativeDriverInnerFailure | null;
  readonly innerResult: NativeDriverInnerResult | null;
}
export interface NativeDriverEvidence {
  readonly driverOutcome: "unknown" | "zero" | "nonzero" | "timeout" | "rejected";
  readonly driverExitCode: number | null;
  readonly innerPhase: NativeDriverInnerPhase | null;
  readonly innerFailure: NativeDriverInnerFailure | null;
  readonly innerResult: NativeDriverInnerResult | null;
  readonly outerCleanupJoined: boolean;
}
export type NativeDriverAttemptEvidence = Omit<NativeDriverEvidence, "outerCleanupJoined">;
const refused = () => new Error("Native driver evidence refused.");
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || NodeUtil.types.isProxy(value))
    throw refused();
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    !own.every((key) => typeof key === "string" && keys.includes(key))
  )
    throw refused();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property?.enumerable || !Object.hasOwn(property, "value")) throw refused();
    result[key] = property.value;
  }
  return result;
}
function count(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > maximum)
    throw refused();
  return value;
}
function inner(value: Record<string, unknown>) {
  const phase = value.innerPhase;
  if (phase !== null && !nativeDriverInnerPhases.some((candidate) => candidate === phase))
    throw refused();
  const innerPhase =
    phase === null
      ? null
      : (nativeDriverInnerPhases.find((candidate) => candidate === phase) ?? null);
  let innerFailure: NativeDriverInnerFailure | null = null;
  if (value.innerFailure !== null) {
    const failure = fields(value.innerFailure, ["status", "reason", "originalCount"]);
    if (failure.status !== "unavailable" || failure.reason !== "native-observation-refused")
      throw refused();
    innerFailure = Object.freeze({
      status: "unavailable",
      reason: "native-observation-refused",
      originalCount: count(failure.originalCount, 6),
    });
  }
  let innerResult: NativeDriverInnerResult | null = null;
  if (value.innerResult !== null) {
    const result = fields(value.innerResult, [
      "originalCount",
      "outstandingRowCount",
      "cleanup",
      "partitionComplete",
      "sourceMatches",
    ]);
    if (
      (result.cleanup !== "joined" && result.cleanup !== "unsafe") ||
      typeof result.partitionComplete !== "boolean" ||
      typeof result.sourceMatches !== "boolean"
    )
      throw refused();
    innerResult = Object.freeze({
      originalCount: count(result.originalCount, 6),
      outstandingRowCount: count(result.outstandingRowCount, 5),
      cleanup: result.cleanup,
      partitionComplete: result.partitionComplete,
      sourceMatches: result.sourceMatches,
    });
  }
  return { innerPhase, innerFailure, innerResult };
}
export function projectNativeDriverHandoff(
  value: unknown,
  sourceSha: string,
): NativeDriverHandoff | null {
  try {
    const record = fields(value, [
      "schemaVersion",
      "selection",
      "sourceSha",
      "partition",
      "innerPhase",
      "innerFailure",
      "innerResult",
    ]);
    if (
      !/^[a-f0-9]{40}$/.test(sourceSha) ||
      record.schemaVersion !== 1 ||
      record.selection !== "release-visual-native-followups" ||
      record.partition !== "linux-menu-update" ||
      record.sourceSha !== sourceSha
    )
      return null;
    return Object.freeze({
      schemaVersion: 1,
      selection: "release-visual-native-followups",
      sourceSha,
      partition: "linux-menu-update",
      ...inner(record),
    });
  } catch {
    return null;
  }
}
export function projectNativeDriverEvidence(value: unknown): NativeDriverEvidence | null {
  if (value === null) return null;
  try {
    const record = fields(value, [
      "driverOutcome",
      "driverExitCode",
      "innerPhase",
      "innerFailure",
      "innerResult",
      "outerCleanupJoined",
    ]);
    const outcome = record.driverOutcome,
      exit = record.driverExitCode;
    if (
      outcome !== "unknown" &&
      outcome !== "zero" &&
      outcome !== "nonzero" &&
      outcome !== "timeout" &&
      outcome !== "rejected"
    )
      return null;
    if (exit !== null) count(exit, 255);
    if (
      typeof record.outerCleanupJoined !== "boolean" ||
      ((outcome === "unknown" || outcome === "timeout" || outcome === "rejected") && exit !== null)
    )
      return null;
    const observation = inner(record);
    if (
      !record.outerCleanupJoined &&
      (observation.innerPhase !== null ||
        observation.innerFailure !== null ||
        observation.innerResult !== null)
    )
      return null;
    return Object.freeze({
      driverOutcome: outcome,
      driverExitCode: exit === null ? null : count(exit, 255),
      ...observation,
      outerCleanupJoined: record.outerCleanupJoined,
    });
  } catch {
    return null;
  }
}
const maximumResultBytes = 1024 * 1024;
function same(left: NodeFS.Stats, right: NodeFS.Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}
export function readOwnedNativeDriverResult(input: {
  readonly runRoot: string;
  readonly resultPath: string;
  readonly sourceSha: string;
}): NativeDriverHandoff | null {
  let handle: number | null = null;
  let observed: NativeDriverHandoff | null = null;
  let closeJoined = true;
  try {
    if (
      input.runRoot !== NodePath.resolve(input.runRoot) ||
      input.resultPath !== NodePath.join(input.runRoot, "before.json") ||
      NodeFS.realpathSync(input.runRoot) !== input.runRoot
    )
      return null;
    const root = NodeFS.lstatSync(input.runRoot),
      before = NodeFS.lstatSync(input.resultPath);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      (root.mode & 0o077) !== 0 ||
      uid === null ||
      root.uid !== uid ||
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.uid !== uid ||
      (before.mode & 0o077) !== 0 ||
      before.size > maximumResultBytes ||
      NodeFS.realpathSync(input.resultPath) !== input.resultPath
    )
      return null;
    handle = NodeFS.openSync(
      input.resultPath,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
    );
    if (!same(before, NodeFS.fstatSync(handle))) return null;
    const bytes = Buffer.alloc(maximumResultBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = NodeFS.readSync(handle, bytes, length, bytes.length - length, length);
      if (read === 0) break;
      length += read;
    }
    if (
      length > maximumResultBytes ||
      !same(before, NodeFS.fstatSync(handle)) ||
      !same(before, NodeFS.lstatSync(input.resultPath)) ||
      !same(root, NodeFS.lstatSync(input.runRoot)) ||
      NodeFS.realpathSync(input.runRoot) !== input.runRoot ||
      NodeFS.realpathSync(input.resultPath) !== input.resultPath
    )
      return null;
    const parsed: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const property = Object.getOwnPropertyDescriptor(parsed, "nativeDriverEvidence");
    observed =
      property && Object.hasOwn(property, "value")
        ? projectNativeDriverHandoff(property.value, input.sourceSha)
        : null;
  } catch {
    return null;
  } finally {
    if (handle !== null) {
      try {
        NodeFS.closeSync(handle);
      } catch {
        closeJoined = false;
      }
    }
  }
  return closeJoined ? observed : null;
}
