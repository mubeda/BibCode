import { WS_METHODS } from "@bibcode/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

/**
 * Connect an agent (#139): whether Claude Code and Codex on an environment's host have
 * BiBCode added (`access:read`), and adding or removing it (`access:write`). The read runs
 * each tool's CLI and may start a health check, so it is never polled: it is read when shown
 * and again after a change. Changes of one environment run one at a time.
 */
export function createMcpClientsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  return {
    registrations: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:mcp-clients:registrations",
      tag: WS_METHODS.mcpClientsGetRegistrations,
    }),
    register: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:mcp-clients:register",
      tag: WS_METHODS.mcpClientsRegister,
      scheduler,
    }),
    unregister: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:mcp-clients:unregister",
      tag: WS_METHODS.mcpClientsUnregister,
      scheduler,
    }),
  };
}
