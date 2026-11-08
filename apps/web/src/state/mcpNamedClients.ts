import type { AuthAccessSnapshot, AuthMcpNamedClient } from "@bibcode/contracts";

const NO_NAMED_CLIENTS: ReadonlyArray<AuthMcpNamedClient> = [];

/**
 * Named MCP clients with no live run (#324): an agent started with `bibcode mcp --client`
 * whose identity outlives its last run. Revoke on one ends that identity.
 */
export function idleNamedClients(
  snapshot: AuthAccessSnapshot | undefined,
): ReadonlyArray<AuthMcpNamedClient> {
  const named = snapshot?.mcpNamedClients;
  if (named === undefined || named.length === 0) return NO_NAMED_CLIENTS;
  const running = new Set(
    snapshot?.clientSessions.flatMap((session) =>
      session.mcpNamedClient === undefined ? [] : [session.mcpNamedClient.id],
    ),
  );
  return named.filter((client) => !running.has(client.id));
}
