// @effect-diagnostics nodeBuiltinImport:off - Reject Node proxies before reading closed failure facts.
import * as NodeUtil from "node:util";
import { visualWitnessKeys } from "./release-visual-evidence.ts";

const factKeys = visualWitnessKeys("git-branch-menu");
const ownershipKeys = ["source", "scene", "theme", "origin", "threadId", "branch"] as const;
const managedKeys = ["theme", "origin", "threadId", "branch"] as const;

/** No getter, proxy trap, inherited field, or extra key can supply retained data. */
function ownDataFields(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      NodeUtil.types.isProxy(value) ||
      Array.isArray(value)
    )
      return null;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      !ownKeys.every((key) => typeof key === "string" && keys.includes(key))
    )
      return null;
    const fields: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null;
      fields[key] = descriptor.value;
    }
    return fields;
  } catch {
    return null;
  }
}

/** This is diagnostic projection, never capture approval. Unsafe context remains unavailable. */
export function projectCoreBranchCaptureFailureWitness(
  value: unknown,
): Readonly<Record<string, boolean>> | null {
  try {
    const fields = ownDataFields(value, factKeys);
    if (fields === null || !factKeys.every((key) => typeof fields[key] === "boolean")) return null;
    if (
      ["themeMatched", "selectedMatched", "credentialAbsent", "bootShellAbsent"].some(
        (key) => fields[key] !== true,
      )
    )
      return null;
    return Object.freeze(fields as Record<string, boolean>);
  } catch {
    return null;
  }
}

export interface CoreBranchCaptureOwnership {
  readonly source: string;
  readonly scene: "git-branch-menu";
  readonly theme: "light" | "dark";
  readonly origin: string;
  readonly threadId: string;
  readonly branch: string;
}
export interface CoreBranchCaptureFailureRecord {
  readonly ownership: Readonly<CoreBranchCaptureOwnership>;
  readonly witness: Readonly<Record<string, boolean>>;
}

function ownership(value: unknown, current = false): Readonly<CoreBranchCaptureOwnership> | null {
  try {
    const fields = ownDataFields(value, current ? [...ownershipKeys, "phase"] : ownershipKeys);
    if (
      fields === null ||
      typeof fields.source !== "string" ||
      !/^[0-9a-f]{40}$/.test(fields.source) ||
      fields.scene !== "git-branch-menu" ||
      (fields.theme !== "light" && fields.theme !== "dark") ||
      fields.origin !== "http://127.0.0.1:4885" ||
      typeof fields.threadId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(fields.threadId) ||
      fields.branch !== "codex/delivery-retry-" + fields.theme ||
      (current && fields.phase !== "visual-git-branch-menu")
    )
      return null;
    return Object.freeze(
      Object.fromEntries(ownershipKeys.map((key) => [key, fields[key]])),
    ) as unknown as Readonly<CoreBranchCaptureOwnership>;
  } catch {
    return null;
  }
}

/** Bind only to the identity already verified by the existing managed-worktree callback. */
export function createCoreBranchCaptureFailureObserver(
  records: WeakMap<object, CoreBranchCaptureFailureRecord>,
  input: unknown,
  verifiedManaged: unknown,
) {
  const admitted = ownership(input);
  const managed = ownDataFields(verifiedManaged, managedKeys);
  const joined =
    admitted !== null &&
    managed !== null &&
    managedKeys.every((key) => managed[key] === admitted[key]);
  return (error: unknown, value: unknown) => {
    try {
      if (
        error === null ||
        typeof error !== "object" ||
        NodeUtil.types.isProxy(error) ||
        NodeUtil.types.isProxy(records)
      )
        return;
      WeakMap.prototype.delete.call(records, error);
      if (!joined || admitted === null) return;
      const witness = projectCoreBranchCaptureFailureWitness(value);
      if (witness !== null)
        WeakMap.prototype.set.call(records, error, Object.freeze({ ownership: admitted, witness }));
    } catch {
      /* Optional facts cannot replace the original capture failure. */
    }
  };
}

/** Rejoin current private source/identity; export only the fixed scene/theme and closed booleans. */
export function readCoreBranchCaptureFailureFacts(
  records: WeakMap<object, CoreBranchCaptureFailureRecord>,
  error: unknown,
  current: unknown,
) {
  try {
    const expected = ownership(current, true);
    if (
      expected === null ||
      error === null ||
      typeof error !== "object" ||
      NodeUtil.types.isProxy(error) ||
      NodeUtil.types.isProxy(records)
    )
      return null;
    const fields = ownDataFields(WeakMap.prototype.get.call(records, error), [
      "ownership",
      "witness",
    ]);
    if (fields === null) return null;
    const admitted = ownership(fields.ownership);
    if (admitted === null || !ownershipKeys.every((key) => admitted[key] === expected[key]))
      return null;
    const witness = projectCoreBranchCaptureFailureWitness(fields.witness);
    return witness === null
      ? null
      : Object.freeze({ scene: admitted.scene, theme: admitted.theme, witness });
  } catch {
    return null;
  }
}
