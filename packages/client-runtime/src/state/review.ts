import { WS_METHODS } from "@bibcode/contracts";
import { Atom } from "effect/reactivity";

import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createReviewEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    diffPreview: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:review:diff-preview",
      tag: WS_METHODS.reviewGetDiffPreview,
      staleTimeMs: 5_000,
    }),
    /**
     * A patch with `contextLines`. It is its own family and is never retained once released,
     * so stepping the count does not keep a multi-megabyte patch per value.
     */
    contextDiffPreview: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:review:context-diff-preview",
      tag: WS_METHODS.reviewGetDiffPreview,
      staleTimeMs: 5_000,
      idleTtlMs: 0,
    }),
    /**
     * One side of a changed file, up to about 4.4 MB. Releasing the query interrupts a read in
     * flight and drops its result, so only the selected file's versions stay in memory.
     */
    fileVersion: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:review:file-version",
      tag: WS_METHODS.reviewReadFileVersion,
      idleTtlMs: 0,
    }),
  };
}
