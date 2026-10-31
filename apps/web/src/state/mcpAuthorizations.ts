import type { AuthMcpAccessLevel, AuthPendingMcpAuthorization } from "@bibcode/contracts";

import { decideServerMcpAuthorization } from "../environments/primary";
import { authEnvironment } from "./auth";
import { usePrimaryAgentAccess } from "./mcpActivity";
import { useEnvironmentQuery } from "./query";

const NO_REQUESTS: ReadonlyArray<AuthPendingMcpAuthorization> = [];

/**
 * The primary environment's remote MCP requests to connect (#139, slice R), from the access
 * stream that Authorized clients reads. Shown where this app manages access, with
 * `access:write` to decide them.
 */
export function usePrimaryMcpAuthorizations(): {
  readonly requests: ReadonlyArray<AuthPendingMcpAuthorization>;
  readonly canManage: boolean;
} {
  const access = usePrimaryAgentAccess();
  const changes = useEnvironmentQuery(
    access.canRead && access.environmentId !== null
      ? authEnvironment.accessChanges({ environmentId: access.environmentId, input: null })
      : null,
  );
  const requests =
    changes.data?.type === "snapshot"
      ? (changes.data.payload.pendingMcpAuthorizations ?? NO_REQUESTS)
      : NO_REQUESTS;
  return { requests, canManage: access.canManage };
}

/** **Approve**, at `access` and with or without terminals. */
export function approveMcpAuthorization(
  id: string,
  access: AuthMcpAccessLevel,
  terminals: boolean,
): Promise<void> {
  return decideServerMcpAuthorization({ kind: "approve", id, access, terminals });
}

/** **Deny**. */
export function denyMcpAuthorization(id: string): Promise<void> {
  return decideServerMcpAuthorization({ kind: "deny", id });
}

/** What a request may do, in words: "read and operate", "+ terminals". */
export function requestedScopeText(scopes: ReadonlyArray<string>): string {
  const operate = scopes.includes("orchestration:operate");
  const read = scopes.includes("orchestration:read");
  const base = operate ? "Read and operate" : read ? "Read" : "No tools";
  return scopes.includes("terminal:operate") ? `${base}, and use terminals` : base;
}

/** The MCP URL a remote AI tool connects to: the environment's address, over HTTPS only. */
export function remoteMcpUrl(httpBaseUrl: string | null): string | null {
  if (httpBaseUrl === null) return null;
  try {
    const url = new URL(httpBaseUrl);
    return url.protocol === "https:" ? `${url.origin}/mcp` : null;
  } catch {
    return null;
  }
}
