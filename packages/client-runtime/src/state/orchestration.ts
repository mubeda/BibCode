import { ORCHESTRATION_WS_METHODS } from "@bibcode/contracts";
import { Atom } from "effect/reactivity";

import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createOrchestrationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    turnDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:turn-diff",
      tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
    }),
    fullThreadDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:full-thread-diff",
      tag: ORCHESTRATION_WS_METHODS.getFullThreadDiff,
    }),
    /** Turn patches with `contextLines`, never retained once released (see review's). */
    turnContextDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:turn-context-diff",
      tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
      staleTimeMs: 5_000,
      idleTtlMs: 0,
    }),
    fullThreadContextDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:full-thread-context-diff",
      tag: ORCHESTRATION_WS_METHODS.getFullThreadDiff,
      staleTimeMs: 5_000,
      idleTtlMs: 0,
    }),
    archivedShellSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:archived-shell-snapshot",
      tag: ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
    }),
    /** A page of the threads a capped shell left out, or a title search (#223). */
    listOlderThreads: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:orchestration:list-older-threads",
      tag: ORCHESTRATION_WS_METHODS.listOlderThreads,
    }),
    /** Threads by id, live or archived, and the ids that are gone (#223). */
    getThreadShells: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:orchestration:get-thread-shells",
      tag: ORCHESTRATION_WS_METHODS.getThreadShells,
    }),
  };
}
