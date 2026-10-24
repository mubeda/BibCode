import { WS_METHODS } from "@bibcode/contracts";
import { Atom } from "effect/reactivity";

import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/** The diff apps found where a server runs change rarely, and the list is a few hundred bytes. */
const DIFF_TOOLS_RETENTION_MS = 10 * 60_000;

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
    /**
     * The diff apps for **Open with**, per environment and `cwd`. Probing them takes a second or
     * two, so the list is kept for ten minutes and menus for one `cwd` share one request.
     */
    diffTools: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:review:diff-tools",
      tag: WS_METHODS.reviewListDiffTools,
      staleTimeMs: DIFF_TOOLS_RETENTION_MS,
      idleTtlMs: DIFF_TOOLS_RETENTION_MS,
    }),
    /** Opens a diff app on the server's computer. A mutation, so it is never retried. */
    openDiffTool: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:review:open-diff-tool",
      tag: WS_METHODS.reviewOpenDiffTool,
    }),
  };
}
