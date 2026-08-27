import { useNavigate } from "@tanstack/react-router";
import { EllipsisIcon } from "lucide-react";
import * as React from "react";
import { useMemo } from "react";

import type { EnvironmentId } from "@bibcode/contracts";

import { environmentCatalog } from "../../connection/catalog";
import { cn } from "../../lib/utils";
import { useActiveEnvironmentId } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { buildEnvironmentContextCardView } from "./environmentContextCard.logic";
import type { EnvironmentRailStatus } from "./environmentRail.logic";

const CARD_STATUS_DOT_CLASS: Record<EnvironmentRailStatus, string> = {
  connected: "bg-success",
  disconnected: "bg-muted-foreground/50",
  attention: "bg-warning",
  error: "bg-destructive",
};

export interface EnvironmentContextCardProps {
  readonly updateBadge?: React.ReactNode;
  readonly onCheckForUpdates?: (environmentId: EnvironmentId) => void;
}

/** Remote-environment context and actions; hidden for this machine. */
export function EnvironmentContextCard(props: EnvironmentContextCardProps) {
  const activeEnvironmentId = useActiveEnvironmentId();
  const environment = useEnvironment(activeEnvironmentId);
  const navigate = useNavigate();
  const disconnectEnvironment = useAtomCommand(environmentCatalog.disconnect, {
    reportFailure: false,
  });

  const view = useMemo(
    () =>
      environment === null
        ? null
        : buildEnvironmentContextCardView({
            label: environment.label,
            target: environment.entry.target,
            connection: environment.connection,
            serverConfig: environment.serverConfig,
          }),
    [environment],
  );

  if (view === null || activeEnvironmentId === null) {
    return null;
  }

  return (
    <div
      data-testid="environment-context-card"
      className="mx-2 mb-1 flex items-center gap-2 rounded-[10px] border border-border bg-background px-2.5 py-2"
    >
      <span
        data-status={view.status}
        className={cn("size-2 shrink-0 rounded-full", CARD_STATUS_DOT_CLASS[view.status])}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold text-foreground">{view.name}</div>
        <div className="flex min-w-0 items-center gap-1 truncate text-[11px] text-muted-foreground">
          <span className="truncate">{view.statusText}</span>
          {view.versionLine ? <span aria-hidden>·</span> : null}
          {view.versionLine ? <span className="shrink-0">{view.versionLine}</span> : null}
          {view.compatBadge ? (
            <span
              data-tone={view.compatBadge.tone}
              className={cn(
                "shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium",
                view.compatBadge.tone === "error"
                  ? "bg-destructive/12 text-destructive-foreground"
                  : "bg-warning/15 text-warning-foreground",
              )}
            >
              {view.compatBadge.label}
            </span>
          ) : null}
          {props.updateBadge ?? null}
        </div>
      </div>
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label="Environment actions"
              data-testid="environment-context-card-menu"
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            />
          }
        >
          <EllipsisIcon className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={() => void disconnectEnvironment(activeEnvironmentId)}>
            Disconnect
          </MenuItem>
          {view.showUpdateActions && props.onCheckForUpdates !== undefined ? (
            <MenuItem onClick={() => props.onCheckForUpdates?.(activeEnvironmentId)}>
              Check for updates
            </MenuItem>
          ) : null}
          <MenuItem onClick={() => void navigate({ to: "/settings/remote-servers" })}>
            Manage…
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
