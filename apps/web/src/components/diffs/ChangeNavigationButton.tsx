import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Previous or Next change. At either end it stays focusable, so its tooltip can say why it does
 * nothing, instead of turning into a control that cannot explain itself.
 */
export function ChangeNavigationButton({
  disabled,
  disabledReason = "No more changes.",
  label,
  shortcut,
  onClick,
  children,
}: {
  readonly disabled: boolean;
  readonly disabledReason?: string;
  readonly label: string;
  readonly shortcut: string | null;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-disabled={disabled}
            aria-label={label}
            className={cn("shrink-0", disabled && "opacity-64")}
            size="icon-xs"
            variant="ghost"
            onClick={() => {
              if (!disabled) onClick();
            }}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {disabled ? disabledReason : shortcut ? `${label} (${shortcut})` : label}
      </TooltipPopup>
    </Tooltip>
  );
}
