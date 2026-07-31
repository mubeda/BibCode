import type { ServerProvider, ServerSettings } from "@bibcode/contracts";
import { PlusIcon, TerminalSquare } from "lucide-react";
import { memo, type ReactElement } from "react";

import type { ProviderInstanceEntry } from "~/providerInstances";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { buildProviderAgentActions } from "./providerAgentActions";
import type { ProviderTerminalAction } from "./providerTerminalActions";

interface ChatHeaderPanelMenuProps {
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly settings: Pick<
    ServerSettings,
    "providerInstances" | "providers" | "providerSessionDefaults"
  >;
  /** False when the host thread can't yet spawn sibling panels (no thread ref). */
  readonly canCreatePanel: boolean;
  readonly onCreateChatPanel: (entry: ProviderInstanceEntry) => void;
  readonly onOpenTerminalPanel: () => void;
  readonly onOpenProviderTerminalPanel: (action: ProviderTerminalAction) => void;
  readonly onAddCustomAction: () => void;
}

const PANEL_UNAVAILABLE_REASON = "Available once this thread has started.";

function DisabledReasonTooltip(props: { reason: string; trigger: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.trigger} />
      <TooltipPopup side="top">{props.reason}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The chat-header "+" menu: create a new chat panel for any enabled provider
 * instance, open a center terminal panel, or add a custom project action
 * (the entry point that replaces ProjectScriptsControl's old bare "+").
 */
export const ChatHeaderPanelMenu = memo(function ChatHeaderPanelMenu({
  providerStatuses,
  settings,
  canCreatePanel,
  onCreateChatPanel,
  onOpenTerminalPanel,
  onOpenProviderTerminalPanel,
  onAddCustomAction,
}: ChatHeaderPanelMenuProps) {
  const agentActions = buildProviderAgentActions(providerStatuses, settings);
  const chatActions = agentActions.filter((action) => action.kind === "chat");
  const terminalActions = agentActions.filter((action) => action.kind === "terminal");

  return (
    <Menu>
      <MenuTrigger render={<Button size="icon-xs" variant="outline" aria-label="New panel" />}>
        <PlusIcon className="size-4" />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-52">
        {chatActions.map((action) => {
          const disabled = action.disabled || !canCreatePanel;
          const reason = canCreatePanel ? action.disabledReason : PANEL_UNAVAILABLE_REASON;
          const menuItem = (
            <MenuItem
              key={action.value}
              className={disabled ? "data-disabled:pointer-events-auto" : undefined}
              disabled={disabled}
              onClick={() => onCreateChatPanel(action.entry)}
            >
              <ProviderInstanceIcon
                driverKind={action.entry.driverKind}
                displayName={action.entry.displayName}
                accentColor={action.entry.accentColor}
                iconClassName="size-4"
              />
              <span className="truncate">{action.label}</span>
            </MenuItem>
          );
          return disabled && reason ? (
            <DisabledReasonTooltip key={action.value} reason={reason} trigger={menuItem} />
          ) : (
            menuItem
          );
        })}
        {chatActions.length > 0 ? <MenuSeparator /> : null}
        {canCreatePanel ? (
          <MenuItem onClick={onOpenTerminalPanel}>
            <TerminalSquare className="size-4" />
            Open Terminal
          </MenuItem>
        ) : (
          <DisabledReasonTooltip
            reason={PANEL_UNAVAILABLE_REASON}
            trigger={
              <MenuItem className="data-disabled:pointer-events-auto" disabled>
                <TerminalSquare className="size-4" />
                Open Terminal
              </MenuItem>
            }
          />
        )}
        {terminalActions.length > 0 ? (
          <>
            <MenuSeparator />
            {terminalActions.map((action) => {
              const terminalAction = action.terminalAction;
              const disabled = action.disabled || !canCreatePanel;
              const reason = !canCreatePanel ? PANEL_UNAVAILABLE_REASON : action.disabledReason;
              const menuItem = (
                <MenuItem
                  key={action.value}
                  className={disabled ? "data-disabled:pointer-events-auto" : undefined}
                  disabled={disabled}
                  onClick={() => {
                    if (disabled) {
                      return;
                    }
                    if (terminalAction.command !== null) {
                      if (terminalAction.fallback) {
                        console.warn("Provider session default fallback", terminalAction.fallback);
                      }
                      onOpenProviderTerminalPanel(terminalAction);
                    }
                  }}
                >
                  <ProviderInstanceIcon
                    driverKind={action.entry.driverKind}
                    displayName={action.entry.displayName}
                    accentColor={action.entry.accentColor}
                    iconClassName="size-4"
                  />
                  <span className="truncate">{action.label}</span>
                </MenuItem>
              );
              return disabled && reason ? (
                <DisabledReasonTooltip key={action.value} reason={reason} trigger={menuItem} />
              ) : (
                menuItem
              );
            })}
          </>
        ) : null}
        <MenuSeparator />
        <MenuItem onClick={onAddCustomAction}>
          <PlusIcon className="size-4" />
          Add custom action…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
});

export default ChatHeaderPanelMenu;
