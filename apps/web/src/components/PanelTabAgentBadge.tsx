import type { OrchestrationThreadRequester, ThreadId } from "@bibcode/contracts";
import { findThreadRef, useThreadShell } from "~/state/entities";
import { agentChipText } from "./chat/AgentActorChip";

/**
 * The outside agent that opened a chat panel and why (#139, slices X1 and X4), or `null` for a
 * panel a person opened and for tabs that are not chat panels. Thread ids are unique across
 * environments, so the panel's thread is found by id; the tab bar has no environment of its own.
 */
export function usePanelRequester(threadId: ThreadId | null): OrchestrationThreadRequester | null {
  // Looked up on every render, not memoized: a tab restored before its thread's shell arrives
  // finds it on a later render. The shell atom is keyed by the ref's string key.
  const ref = threadId === null ? null : findThreadRef(threadId);
  return useThreadShell(ref)?.requester ?? null;
}

/**
 * Marks a chat panel tab an agent opened. It sits inside the tab's button, so it is plain text,
 * not a control; the tab's tooltip names the agent and the purpose.
 */
export function PanelTabAgentBadge({
  requester,
}: {
  readonly requester: OrchestrationThreadRequester;
}) {
  return (
    <span
      data-panel-agent-badge=""
      className="shrink-0 rounded-sm bg-info/8 px-1 text-xs leading-4 text-info-foreground dark:bg-info/16"
    >
      Agent
      <span className="sr-only">{`, opened by ${agentChipText(requester.actor.label)}`}</span>
    </span>
  );
}

/** The tab tooltip's line for an agent's panel: who opened it, and why when it said. */
export function PanelTabAgentTooltip({
  requester,
}: {
  readonly requester: OrchestrationThreadRequester;
}) {
  const purpose = requester.purpose?.trim();
  return (
    <div className="mt-0.5 max-w-64 text-xs text-muted-foreground">
      {`Opened by ${agentChipText(requester.actor.label)}`}
      {purpose ? <div>{purpose}</div> : null}
    </div>
  );
}
