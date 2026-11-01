import type { EnvironmentId } from "@bibcode/contracts";
import { createMcpClientsEnvironmentAtoms } from "@bibcode/client-runtime/state/mcpClients";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const mcpClientsEnvironment = createMcpClientsEnvironmentAtoms(connectionAtomRuntime);

/** Whether Claude Code and Codex on the environment's host have BiBCode added; `null` reads nothing. */
export function useMcpClientRegistrations(environmentId: EnvironmentId | null) {
  return useEnvironmentQuery(
    environmentId === null
      ? null
      : mcpClientsEnvironment.registrations({ environmentId, input: {} }),
  );
}
