import type {
  AuthClientSession,
  AuthMcpNamedClient,
  McpActiveClient,
  McpActivityRow,
} from "@bibcode/contracts";
import { useMemo } from "react";

import {
  takenOverLevel,
  usePrimaryIdleNamedClients,
  usePrimaryMcpActivity,
  usePrimaryMcpClients,
} from "~/state/mcpActivity";
import { Button } from "../ui/button";
import { useMcpAgentActions } from "./useMcpAgentActions";
import { SettingsRow } from "./settingsLayout";

const ACTIVITY_SHOWN = 50;

const ENDS_IDENTITY =
  "Ends this agent's identity. Its paired webhooks turn off, and its next run starts fresh.";

/** The labels Agents may uses for each level. */
const ACCESS_LABELS: Readonly<Record<string, string>> = {
  "read-only": "Read only",
  "approval-required": "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  "full-access": "Full access",
};

function accessLabel(access: string | undefined): string {
  return (access !== undefined ? ACCESS_LABELS[access] : undefined) ?? "Read only";
}

function scopeSummary(scopes: ReadonlyArray<string>): string {
  const parts = [
    scopes.includes("orchestration:operate")
      ? "operate"
      : scopes.includes("orchestration:read")
        ? "read"
        : null,
    scopes.includes("terminal:operate") ? "terminals" : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "No tools" : parts.join(", ");
}

/** "commit abc1234", "PR #7", "3 files": what a row acted on, from ids and counts only. */
export function activityTargetText(row: McpActivityRow): string | null {
  const { target } = row;
  const parts = [
    target.sha !== undefined ? `commit ${target.sha.slice(0, 7)}` : null,
    target.revertedSha !== undefined ? `reverted ${target.revertedSha.slice(0, 7)}` : null,
    target.pullRequest !== undefined ? `PR #${target.pullRequest}` : null,
    target.fileCount !== undefined
      ? `${target.fileCount} ${target.fileCount === 1 ? "file" : "files"}`
      : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

function timeText(iso: string | null | undefined): string {
  if (!iso) return "never";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

/**
 * Settings → Agent integrations → **Agents** (#139, slice X1): each authorized outside agent
 * with its label, last call, scopes and access, **Revoke** and **Take over** (or **Hand
 * back**), and below it what agents did. Shown for the environment this app manages access
 * for, as Authorized clients is. Labels are untrusted text, rendered as text.
 */
export function McpAgentsPanel() {
  const { rows, active, canManage } = usePrimaryMcpActivity();
  const clients = usePrimaryMcpClients();
  const idle = usePrimaryIdleNamedClients();
  return (
    <>
      <SettingsRow
        title="Agents"
        description="Outside agents authorized to use this environment's MCP server. Revoke ends an agent's access; Take over leaves it read only until you hand it back."
      >
        <McpAgentList
          clients={clients}
          idle={idle}
          active={active}
          rows={rows}
          canManage={canManage}
        />
      </SettingsRow>
      <SettingsRow title="Agent activity" description="What agents changed here, newest first.">
        <McpActivityList rows={rows} />
      </SettingsRow>
    </>
  );
}

function McpAgentList({
  clients,
  idle,
  active,
  rows,
  canManage,
}: {
  readonly clients: ReadonlyArray<AuthClientSession>;
  readonly idle: ReadonlyArray<AuthMcpNamedClient>;
  readonly active: ReadonlyArray<McpActiveClient>;
  readonly rows: ReadonlyArray<McpActivityRow>;
  readonly canManage: boolean;
}) {
  const actions = useMcpAgentActions();
  const lastCalls = useMemo(() => {
    const calls = new Map<string, string>();
    for (const entry of active) {
      if (entry.lastCallAt !== null) calls.set(entry.clientId, entry.lastCallAt);
    }
    for (const row of rows) {
      if (!calls.has(row.clientId)) calls.set(row.clientId, row.occurredAt);
    }
    return calls;
  }, [active, rows]);
  const runningTurns = useMemo(
    () => new Map(active.map((entry) => [entry.clientId, entry.runningTurns] as const)),
    [active],
  );
  // A revoked agent is no authorized client, but its turns may still run: list it so Stop
  // stays in reach.
  const revokedRunning = active.filter(
    (entry) =>
      entry.runningTurns > 0 && !clients.some((client) => client.sessionId === entry.clientId),
  );
  if (clients.length === 0 && idle.length === 0 && revokedRunning.length === 0) {
    return (
      <p className="pb-3.5 text-xs text-muted-foreground">
        No agent is authorized. Copy a command above into your agent to connect one.
      </p>
    );
  }
  const stopButton = (clientId: string, title?: string) =>
    canManage && (runningTurns.get(clientId) ?? 0) > 0 ? (
      <Button
        size="sm"
        variant="outline"
        disabled={actions.pendingClientId === clientId}
        title={title}
        onClick={() => void actions.stop(clientId)}
      >
        Stop
      </Button>
    ) : null;
  return (
    <ul className="divide-y divide-border/60 pb-1" aria-label="Authorized agents">
      {revokedRunning.map((entry) => (
        <li key={entry.clientId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] text-foreground">
              {entry.label?.trim() || "MCP agent"}
            </div>
            <div className="text-xs text-muted-foreground">
              Revoked · {turnsText(entry.runningTurns)}
            </div>
          </div>
          {stopButton(
            entry.clientId,
            entry.namedClientId === undefined ? undefined : ENDS_IDENTITY,
          )}
        </li>
      ))}
      {clients.map((client) => {
        const handBack = takenOverLevel(client);
        const busy = actions.pendingClientId === client.sessionId;
        const label = client.client.label?.trim() || "MCP agent";
        const turns = runningTurns.get(client.sessionId) ?? 0;
        // A named client (`bibcode mcp --client`) is one identity across runs: Revoke and
        // Stop end all of it, not only this run.
        const named = client.mcpNamedClient !== undefined;
        const endsIdentity = named ? ENDS_IDENTITY : undefined;
        return (
          <li key={client.sessionId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] text-foreground">{label}</div>
              <div className="text-xs text-muted-foreground">
                Last call {timeText(lastCalls.get(client.sessionId))} ·{" "}
                {scopeSummary(client.scopes)} ·{" "}
                {handBack !== null
                  ? `Taken over (was ${accessLabel(handBack)})`
                  : accessLabel(client.mcpAccess)}
                {turns > 0 ? ` · ${turnsText(turns)}` : ""}
                {named ? " · Keeps its identity across runs" : ""}
              </div>
            </div>
            {canManage ? (
              <div className="flex shrink-0 items-center gap-1.5">
                {stopButton(client.sessionId, endsIdentity)}
                {handBack !== null ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void actions.handBack(client.sessionId, handBack)}
                  >
                    Hand back
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || client.mcpAccess === "read-only"}
                    title={
                      client.mcpAccess === "read-only"
                        ? "This agent is already read only."
                        : undefined
                    }
                    onClick={() => void actions.takeOver(client.sessionId)}
                  >
                    Take over
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  title={endsIdentity}
                  onClick={() => void actions.revoke(client.sessionId)}
                >
                  Revoke
                </Button>
              </div>
            ) : null}
          </li>
        );
      })}
      {idle.map((named) => (
        // A named client with no run live (#324): its identity stays until a person revokes it.
        <li key={named.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] text-foreground">
              {named.name.trim() ? `MCP · ${named.name}` : "MCP agent"}
            </div>
            <div className="text-xs text-muted-foreground">
              Not running · Keeps its identity across runs
            </div>
          </div>
          {canManage ? (
            <Button
              size="sm"
              variant="outline"
              disabled={actions.pendingClientId === named.id}
              title={ENDS_IDENTITY}
              onClick={() => void actions.revoke(named.id)}
            >
              Revoke
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function turnsText(turns: number): string {
  return turns === 1 ? "1 turn running" : `${turns} turns running`;
}

/** A row's outcome in plain words; the typed tag stays in the tooltip. */
export function outcomeText(outcome: string): string {
  if (outcome === "success") return "Done";
  if (outcome === "McpOutcomeUnknownError") return "Outcome unknown";
  if (outcome === "McpCancelledError") return "Cancelled";
  return "Failed";
}

function McpActivityList({ rows }: { readonly rows: ReadonlyArray<McpActivityRow> }) {
  if (rows.length === 0) {
    return (
      <p className="pb-3.5 text-xs text-muted-foreground">No agent has changed anything yet.</p>
    );
  }
  return (
    <ol
      data-text-surface
      className="max-h-72 divide-y divide-border/60 overflow-auto pb-1"
      aria-label="Agent activity"
    >
      {rows.slice(0, ACTIVITY_SHOWN).map((row) => {
        const target = activityTargetText(row);
        return (
          <li key={row.id} className="flex items-center gap-2 py-1.5 text-xs">
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {timeText(row.occurredAt)}
            </span>
            <span className="min-w-0 truncate text-foreground">
              {row.label?.trim() || "MCP agent"} · <span className="font-mono">{row.tool}</span>
              {target !== null ? ` · ${target}` : ""}
            </span>
            <span
              title={row.outcome === "success" ? undefined : row.outcome}
              className={`ms-auto shrink-0 ${row.outcome === "success" ? "text-muted-foreground" : "text-destructive-foreground"}`}
            >
              {outcomeText(row.outcome)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
