import type { EnvironmentId } from "@bibcode/contracts";
import { GaugeIcon, TerminalSquareIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SERVER_COMMANDS,
  serverCommandAccessibleName,
  serverCommandUnavailableReason,
  type ServerCommandTarget,
  useRunServerCommand,
} from "./serverCommands";

const ICONS = { terminal: TerminalSquareIcon, dashboard: GaugeIcon } as const;

/**
 * Open terminal and Dashboard as icon buttons. An unavailable command stays focusable with
 * `aria-disabled`, so its tooltip and description can say why.
 */
export function ServerCommandButtons({
  environmentId,
  target,
  className,
  iconClassName = "size-3.5",
}: {
  readonly environmentId: EnvironmentId;
  readonly target: ServerCommandTarget;
  readonly className: string;
  readonly iconClassName?: string;
}) {
  const runServerCommand = useRunServerCommand();
  const reason = serverCommandUnavailableReason(target);
  return SERVER_COMMANDS.map((command) => {
    const Icon = ICONS[command.id];
    return (
      <Tooltip key={command.id}>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={serverCommandAccessibleName(command.id, target.label)}
              aria-disabled={reason === null ? undefined : true}
              aria-description={reason ?? undefined}
              data-testid={`server-command-${command.id}`}
              className={className}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (reason !== null) return;
                runServerCommand(command.id, environmentId);
              }}
            />
          }
        >
          <Icon aria-hidden="true" className={iconClassName} />
        </TooltipTrigger>
        <TooltipPopup side="top">{reason ?? command.label}</TooltipPopup>
      </Tooltip>
    );
  });
}
