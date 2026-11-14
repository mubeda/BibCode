import type { OrchestrationActor } from "@bibcode/contracts";
import { BotIcon, MessagesSquareIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** "Agent · <label>", or "Agent" for an agent with no label. Labels are untrusted text. */
export function agentChipText(label: string | null | undefined): string {
  const trimmed = label?.trim();
  return trimmed ? `Agent · ${trimmed}` : "Agent";
}

/** "From agent · <title>", or "From another agent" without one. Titles are untrusted text. */
export function hostedAgentChipText(title: string | null | undefined): string {
  const trimmed = title?.trim();
  return trimmed ? `From agent · ${trimmed}` : "From another agent";
}

const OUTSIDE_DETAIL = "An outside agent did this over MCP.";
const HOSTED_DETAIL = "Sent by another agent in this project. You did not write it.";

/**
 * Who acted (#139, slice X1): marks a message an outside agent sent, a thread or panel it
 * created (with its purpose in the tooltip), and a commit it made. `kind="hosted-agent"` marks
 * a message another agent in this project sent; its label is that agent's thread title.
 * `compact` shows the icon only, for tight rows; the text stays readable to assistive
 * technology.
 */
export const AgentActorChip = memo(function AgentActorChip({
  label,
  purpose = null,
  detail,
  kind = "mcp-client",
  compact = false,
  className,
}: {
  readonly label: OrchestrationActor["label"] | undefined;
  readonly purpose?: string | null;
  readonly detail?: string;
  readonly kind?: "mcp-client" | "hosted-agent";
  readonly compact?: boolean;
  readonly className?: string;
}) {
  const hosted = kind === "hosted-agent";
  const text = hosted ? hostedAgentChipText(label) : agentChipText(label);
  const why = purpose?.trim() ? purpose.trim() : null;
  const Icon = hosted ? MessagesSquareIcon : BotIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-agent-chip={hosted ? "hosted-agent" : ""}
            tabIndex={0}
            className={cn(
              "inline-flex h-4.5 max-w-48 shrink-0 items-center gap-1 rounded-sm bg-info/8 px-1 text-xs text-info-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-info/16",
              className,
            )}
          />
        }
      >
        <Icon aria-hidden className="size-3 shrink-0" />
        <span className={compact ? "sr-only" : "truncate"}>{text}</span>
      </TooltipTrigger>
      <TooltipPopup>
        <div className="max-w-64 space-y-0.5 text-xs">
          <div className="font-medium">{text}</div>
          <div className="text-muted-foreground">
            {why ?? detail ?? (hosted ? HOSTED_DETAIL : OUTSIDE_DETAIL)}
          </div>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
});
