import type { OrchestrationActor } from "@bibcode/contracts";
import { BotIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** "Agent · <label>", or "Agent" for an agent with no label. Labels are untrusted text. */
export function agentChipText(label: string | null | undefined): string {
  const trimmed = label?.trim();
  return trimmed ? `Agent · ${trimmed}` : "Agent";
}

/**
 * Who acted (#139, slice X1): marks a message an outside agent sent, a thread or panel it
 * created (with its purpose in the tooltip), and a commit it made. `compact` shows the icon
 * only, for tight rows; the text stays readable to assistive technology.
 */
export const AgentActorChip = memo(function AgentActorChip({
  label,
  purpose = null,
  detail = "An outside agent did this over MCP.",
  compact = false,
  className,
}: {
  readonly label: OrchestrationActor["label"] | undefined;
  readonly purpose?: string | null;
  readonly detail?: string;
  readonly compact?: boolean;
  readonly className?: string;
}) {
  const text = agentChipText(label);
  const why = purpose?.trim() ? purpose.trim() : null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-agent-chip=""
            tabIndex={0}
            className={cn(
              "inline-flex h-4.5 max-w-48 shrink-0 items-center gap-1 rounded-sm bg-info/8 px-1 text-xs text-info-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-info/16",
              className,
            )}
          />
        }
      >
        <BotIcon aria-hidden className="size-3 shrink-0" />
        <span className={compact ? "sr-only" : "truncate"}>{text}</span>
      </TooltipTrigger>
      <TooltipPopup>
        <div className="max-w-64 space-y-0.5 text-xs">
          <div className="font-medium">{text}</div>
          <div className="text-muted-foreground">{why ?? detail}</div>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
});
