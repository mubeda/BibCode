import { memo } from "react";

import { agentChipText } from "../chat/AgentActorChip";
import { useMcpAgentActions } from "../settings/useMcpAgentActions";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { takenOverLevel, usePrimaryMcpActivity, usePrimaryMcpClients } from "~/state/mcpActivity";

const ACTION_CLASS =
  "inline-flex h-5 shrink-0 items-center rounded px-1.5 text-xs font-medium text-foreground outline-none hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60";

/**
 * Who is acting now (#139, slice X1): while an outside agent has a call in the last two
 * minutes or work running, the status bar names it and keeps **Stop** and **Take over** (or
 * **Hand back**) one click away on every screen. `memo` keeps the status bar's frequent
 * re-renders out of it.
 */
export const McpAgentIndicator = memo(function McpAgentIndicator() {
  const { active, canManage } = usePrimaryMcpActivity();
  const clients = usePrimaryMcpClients();
  const actions = useMcpAgentActions();
  const agent = active[0];
  if (agent === undefined) return null;
  const others = active.slice(1);
  const handBack = takenOverLevel(clients.find((client) => client.sessionId === agent.clientId));
  const busy = actions.pendingClientId === agent.clientId;
  const text = agentChipText(agent.label);

  return (
    <div className="inline-flex shrink-0 items-center gap-1" data-testid="mcp-agent-indicator">
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              tabIndex={0}
              className="inline-flex h-5 max-w-56 items-center gap-1.5 rounded px-1 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          <span
            aria-hidden
            className={`size-1.5 shrink-0 rounded-full ${agent.running ? "bg-info" : "bg-muted-foreground/60"}`}
          />
          <span className="truncate">
            {handBack !== null ? "Taken over" : "Agent active"} ·{" "}
            {agent.label?.trim() || "MCP agent"}
            {others.length > 0 ? ` +${others.length}` : ""}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top" align="end">
          <div className="max-w-72 space-y-1 text-xs">
            <div className="font-medium">{text}</div>
            <div className="text-muted-foreground">
              {handBack !== null
                ? "You took over: it can read but not act until you hand it back."
                : agent.running
                  ? "It is working in this environment now."
                  : "It acted in this environment in the last two minutes."}
            </div>
            {others.length > 0 ? (
              <div className="text-muted-foreground">
                Also active: {others.map((other) => other.label?.trim() || "MCP agent").join(", ")}.
                Settings → Agent integrations lists every agent.
              </div>
            ) : null}
          </div>
        </TooltipPopup>
      </Tooltip>
      {canManage ? (
        <>
          <button
            type="button"
            className={ACTION_CLASS}
            disabled={busy}
            onClick={() => void actions.stop(agent.clientId)}
          >
            Stop
          </button>
          {handBack !== null ? (
            <button
              type="button"
              className={ACTION_CLASS}
              disabled={busy}
              onClick={() => void actions.handBack(agent.clientId, handBack)}
            >
              Hand back
            </button>
          ) : (
            <button
              type="button"
              className={ACTION_CLASS}
              disabled={busy}
              onClick={() => void actions.takeOver(agent.clientId)}
            >
              Take over
            </button>
          )}
        </>
      ) : null}
    </div>
  );
});
