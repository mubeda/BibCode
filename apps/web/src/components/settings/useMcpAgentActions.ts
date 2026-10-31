import { AuthSessionId, type AuthMcpAccessLevel } from "@bibcode/contracts";
import { useCallback, useState } from "react";

import { revokeMcpAgent, setMcpAgentAccess, stopMcpAgent } from "~/state/mcpActivity";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * Stop, Revoke, Take over and Hand back for one outside agent at a time. None asks for
 * confirmation: each only stops an agent, and reconnecting or Hand back undoes it. A failure
 * is a toast that says what did not happen.
 */
export function useMcpAgentActions() {
  const [pendingClientId, setPendingClientId] = useState<string | null>(null);
  const run = useCallback(
    async (clientId: string, failure: string, action: (id: AuthSessionId) => Promise<void>) => {
      setPendingClientId(clientId);
      try {
        await action(AuthSessionId.make(clientId));
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: failure,
            description:
              error instanceof Error ? error.message : "Check the connection, then try again.",
          }),
        );
      } finally {
        setPendingClientId((current) => (current === clientId ? null : current));
      }
    },
    [],
  );
  return {
    pendingClientId,
    stop: (clientId: string) => run(clientId, "The agent was not stopped", stopMcpAgent),
    revoke: (clientId: string) => run(clientId, "The agent was not revoked", revokeMcpAgent),
    takeOver: (clientId: string) =>
      run(clientId, "The agent was not taken over", (id) => setMcpAgentAccess(id, "read-only")),
    handBack: (clientId: string, level: AuthMcpAccessLevel) =>
      run(clientId, "The agent was not handed back", (id) => setMcpAgentAccess(id, level)),
  };
}
