import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type AuthClientSession,
  type AuthMcpAccessLevel,
  type AuthSessionId,
  type EnvironmentId,
  type McpActivityRow,
} from "@bibcode/contracts";
import {
  createMcpActivityEnvironmentAtoms,
  EMPTY_MCP_ACTIVITY,
  type McpActivityState,
} from "@bibcode/client-runtime/state/mcpActivity";

import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import {
  revokeServerClientSession,
  setServerMcpClientAccess,
  stopServerMcpClient,
  usePrimarySessionState,
} from "../environments/primary";
import { authEnvironment } from "./auth";
import { usePrimaryEnvironment } from "./environments";
import { useEnvironmentQuery } from "./query";

export const mcpActivityEnvironment = createMcpActivityEnvironmentAtoms(connectionAtomRuntime);

/** The subject of an outside agent's MCP session. */
export const MCP_CLIENT_SUBJECT = "mcp-client";

/**
 * Who may watch and manage outside agents here: the primary environment, as for Authorized
 * clients, with `access:read` to watch and `access:write` to stop or take over.
 */
export function usePrimaryAgentAccess(): {
  readonly environmentId: EnvironmentId | null;
  readonly canRead: boolean;
  readonly canManage: boolean;
} {
  const primaryEnvironment = usePrimaryEnvironment();
  const session = usePrimarySessionState();
  const scopes =
    typeof window !== "undefined" && window.desktopBridge
      ? null
      : session.data?.authenticated
        ? (session.data.scopes ?? [])
        : [];
  const desktop = scopes === null;
  return {
    environmentId: primaryEnvironment?.environmentId ?? null,
    canRead: desktop || scopes.includes(AuthAccessReadScope),
    canManage: desktop || scopes.includes(AuthAccessWriteScope),
  };
}

/** The primary environment's agent activity, or nothing for a session that may not read it. */
export function usePrimaryMcpActivity(): McpActivityState & {
  readonly environmentId: EnvironmentId | null;
  readonly canManage: boolean;
} {
  const access = usePrimaryAgentAccess();
  const query = useEnvironmentQuery(
    access.canRead && access.environmentId !== null
      ? mcpActivityEnvironment.activity({ environmentId: access.environmentId, input: null })
      : null,
  );
  const state = query.data ?? EMPTY_MCP_ACTIVITY;
  return { ...state, environmentId: access.environmentId, canManage: access.canManage };
}

/** The label of the agent whose recent call made each commit, by full and short sha. */
export function agentCommitLabels(
  rows: ReadonlyArray<McpActivityRow>,
): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const row of rows) {
    const sha = row.target.sha;
    if (sha === undefined || row.outcome !== "success") continue;
    const label = row.label ?? "MCP agent";
    if (!labels.has(sha)) labels.set(sha, label);
  }
  return labels;
}

/** The label a commit row shows when an agent's recent call made `sha`. */
export function agentLabelForCommit(
  labels: ReadonlyMap<string, string>,
  sha: string,
): string | null {
  const exact = labels.get(sha);
  if (exact !== undefined) return exact;
  for (const [madeSha, label] of labels) {
    if (madeSha.startsWith(sha) || sha.startsWith(madeSha)) return label;
  }
  return null;
}

const NO_CLIENTS: ReadonlyArray<AuthClientSession> = [];

/** The primary environment's authorized outside agents (`mcp-client` sessions). */
export function usePrimaryMcpClients(): ReadonlyArray<AuthClientSession> {
  const access = usePrimaryAgentAccess();
  const changes = useEnvironmentQuery(
    access.canRead && access.environmentId !== null
      ? authEnvironment.accessChanges({ environmentId: access.environmentId, input: null })
      : null,
  );
  const sessions =
    changes.data?.type === "snapshot" ? changes.data.payload.clientSessions : NO_CLIENTS;
  return useMemo(
    () => sessions.filter((session) => session.subject === MCP_CLIENT_SUBJECT),
    [sessions],
  );
}

/** Whether a person has taken this agent over: Hand back restores the level it names. */
export function takenOverLevel(client: AuthClientSession | undefined): AuthMcpAccessLevel | null {
  const level = client?.mcpAccessHandBack;
  return level === "approval-required" || level === "auto-accept-edits" || level === "full-access"
    ? level
    : null;
}

const NO_AGENT_COMMITS: ReadonlyMap<string, string> = new Map();

/**
 * The agent labels of commits made by recent agent calls in `environmentId`. Only the
 * primary environment's activity is watched, so another environment's commits show none.
 */
export function useAgentCommitLabels(environmentId: EnvironmentId): ReadonlyMap<string, string> {
  const activity = usePrimaryMcpActivity();
  const rows = activity.environmentId === environmentId ? activity.rows : null;
  return useMemo(() => (rows === null ? NO_AGENT_COMMITS : agentCommitLabels(rows)), [rows]);
}

/**
 * **Stop**: revoke the agent and interrupt the turns it is running, also after a Revoke.
 * Fails when the server stopped nothing, so the person is not told it worked.
 */
export async function stopMcpAgent(sessionId: AuthSessionId): Promise<void> {
  const answer = await stopServerMcpClient(sessionId);
  if (!answer.revoked) {
    throw new Error(
      "BiBCode no longer knows this agent. Interrupt its threads from the thread itself.",
    );
  }
  const failed = answer.failed ?? 0;
  if (failed > 0) {
    const total = failed + (answer.interrupted ?? 0);
    throw new Error(
      `The agent is revoked, but ${failed} of ${total} ${total === 1 ? "turn" : "turns"} could not be interrupted. Stop them from their threads.`,
    );
  }
  if (answer.timedOut === true) {
    throw new Error(
      "The agent is revoked, and BiBCode is still interrupting its turns. Check its threads in a moment.",
    );
  }
}

/** **Revoke**: end the agent's access; its running turns go on. */
export function revokeMcpAgent(sessionId: AuthSessionId): Promise<void> {
  return revokeServerClientSession(sessionId);
}

/** **Take over** (`read-only`) or **Hand back** (the level it had). */
export function setMcpAgentAccess(
  sessionId: AuthSessionId,
  access: AuthMcpAccessLevel,
): Promise<void> {
  return setServerMcpClientAccess(sessionId, access);
}
