import { ArrowUpRightIcon } from "lucide-react";
import { memo, useCallback, useId } from "react";

import { cn } from "../../lib/utils";
import { selectIsUnread, useSidebarWorkspaceMetaStore } from "../../sidebarWorkspaceMetaStore";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { SidebarMenuAction, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { type AgentRow, agentRowUnreadKey } from "../sidebar/agentsSection.logic";

export interface AgentsRowProps {
  readonly row: AgentRow;
  readonly selected: boolean;
  readonly onSelect: (key: string) => void;
  /** The row's secondary action; the Inbox omits it (#186). */
  readonly onJumpToWorkspace?: (row: AgentRow) => void;
}

function samePill(left: AgentRow["pill"], right: AgentRow["pill"]): boolean {
  return (
    left === right ||
    (left?.label === right?.label &&
      left?.colorClass === right?.colorClass &&
      left?.dotClass === right?.dotClass &&
      left?.pulse === right?.pulse)
  );
}

function sameAgentRow(left: AgentRow, right: AgentRow): boolean {
  return (
    left === right ||
    (left.key === right.key &&
      left.shell === right.shell &&
      left.branch === right.branch &&
      left.environmentLabel === right.environmentLabel &&
      left.environmentLive === right.environmentLive &&
      left.environmentStatus === right.environmentStatus &&
      left.unknownReason === right.unknownReason &&
      left.terminalId === right.terminalId &&
      left.projectTitle === right.projectTitle &&
      left.providerDriverKind === right.providerDriverKind &&
      left.providerLabel === right.providerLabel &&
      left.previewLine === right.previewLine &&
      samePill(left.pill, right.pill))
  );
}

export const AgentsRow = memo(
  function AgentsRow({ row, selected, onSelect, onJumpToWorkspace }: AgentsRowProps) {
    const isUnread = useSidebarWorkspaceMetaStore((state) =>
      selectIsUnread(state.unreadThreadKeys, agentRowUnreadKey(row)),
    );
    const statusLabel = row.pill?.label ?? "Done";
    const environmentStatus = row.environmentLive ? null : row.environmentStatus;
    const eyebrow = row.projectTitle || row.environmentLabel;
    // Orca's card hierarchy: the branch is the line the eye lands on, the thread
    // title explains it, and the preview shows what the agent is doing now.
    const primaryLine = row.branch ?? row.shell.title;
    const secondaryLine = row.branch === null ? null : row.shell.title;
    const live = row.environmentLive;

    const handleSelect = useCallback(() => {
      onSelect(row.key);
    }, [onSelect, row.key]);
    const handleJumpToWorkspace = useCallback(() => {
      onJumpToWorkspace?.(row);
    }, [onJumpToWorkspace, row]);
    // A terminal row names its terminal, so two agents of one thread read apart.
    const terminalName = row.terminalId === null ? null : row.previewLine;
    const agentName =
      terminalName === null ? row.shell.title : `${row.shell.title}, ${terminalName}`;
    // The card's own lines name it (branch, title, terminal) and describe it (status,
    // provider, environment, project, unread), so its accessible text is what it shows.
    const id = useId();
    const ids = {
      primary: `${id}-primary`,
      secondary: `${id}-secondary`,
      preview: `${id}-preview`,
      status: `${id}-status`,
      provider: `${id}-provider`,
      environment: `${id}-environment`,
      eyebrow: `${id}-eyebrow`,
      unread: `${id}-unread`,
    };
    const labelledBy = [
      ids.primary,
      secondaryLine !== null ? ids.secondary : null,
      terminalName ? ids.preview : null,
    ]
      .filter((part) => part !== null)
      .join(" ");
    const describedBy = [
      ids.status,
      row.providerLabel !== null ? ids.provider : null,
      ids.environment,
      eyebrow ? ids.eyebrow : null,
      isUnread ? ids.unread : null,
    ]
      .filter((part) => part !== null)
      .join(" ");

    return (
      <SidebarMenuItem className="border-b border-border/60 last:border-b-0">
        <SidebarMenuButton
          size="lg"
          isActive={selected}
          className={cn(
            "h-auto items-stretch gap-0 rounded-md px-3 py-2.5 hover:bg-accent/60 data-[active=true]:bg-accent data-[active=true]:font-normal",
            // Room for the Jump to workspace action, only where the host shows it.
            onJumpToWorkspace !== undefined && "pr-9",
          )}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          aria-current={selected ? "true" : undefined}
          onClick={handleSelect}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  row.pill?.dotClass ?? "bg-muted-foreground/40",
                  // A disconnected environment's cached state is not live: nothing pulses.
                  row.pill?.pulse && live && "animate-pulse",
                )}
                aria-hidden
              />
              {row.providerDriverKind !== null ? (
                <ProviderInstanceIcon
                  driverKind={row.providerDriverKind}
                  displayName={row.providerLabel ?? ""}
                  className="size-3.5"
                  iconClassName="size-3.5"
                  showBadge={false}
                />
              ) : null}
              <span
                id={ids.eyebrow}
                className="min-w-0 truncate font-medium uppercase tracking-wide"
              >
                {eyebrow}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1.5 tabular-nums">
                {isUnread ? (
                  <>
                    <span
                      aria-hidden
                      className="size-1.5 shrink-0 rounded-full bg-sky-500 dark:bg-sky-300/80"
                    />
                    <span id={ids.unread} className="sr-only">
                      Unread
                    </span>
                  </>
                ) : null}
                {formatRelativeTimeLabel(row.shell.updatedAt)}
              </span>
            </div>
            <div
              id={ids.primary}
              className={cn(
                "truncate text-sm font-medium",
                live ? "text-foreground" : "text-muted-foreground",
                isUnread && secondaryLine === null && "font-semibold",
              )}
            >
              {primaryLine}
            </div>
            {secondaryLine !== null ? (
              <div
                id={ids.secondary}
                className={cn(
                  "truncate text-[13px]",
                  isUnread
                    ? "font-semibold text-foreground"
                    : live
                      ? "text-foreground/80"
                      : "text-muted-foreground",
                )}
              >
                {secondaryLine}
              </div>
            ) : null}
            {row.previewLine ? (
              <div id={ids.preview} className="truncate text-xs text-muted-foreground">
                {row.previewLine}
              </div>
            ) : null}
            <div className="flex min-w-0 items-center gap-1.5 pt-0.5 text-xs text-muted-foreground">
              <span
                id={ids.status}
                className={cn(
                  "shrink-0 font-medium",
                  row.pill?.colorClass ?? "text-muted-foreground",
                )}
              >
                {statusLabel}
              </span>
              {row.providerLabel !== null ? (
                <>
                  <span aria-hidden>·</span>
                  <span id={ids.provider} className="truncate">
                    {row.providerLabel}
                  </span>
                </>
              ) : null}
              <span
                id={ids.environment}
                className="ml-auto shrink-0 rounded border border-border px-1.5 py-px font-medium"
              >
                {row.environmentLabel}
                {environmentStatus ? ` · ${environmentStatus}` : null}
              </span>
            </div>
          </div>
        </SidebarMenuButton>
        {onJumpToWorkspace !== undefined ? (
          <SidebarMenuAction
            showOnHover
            className="top-2 right-2 size-6 bg-background/80"
            aria-label={`Jump to workspace for ${agentName}`}
            title="Jump to workspace"
            onClick={handleJumpToWorkspace}
          >
            <ArrowUpRightIcon className="size-3.5" aria-hidden />
          </SidebarMenuAction>
        ) : null}
      </SidebarMenuItem>
    );
  },
  (previous, next) =>
    previous.selected === next.selected &&
    previous.onSelect === next.onSelect &&
    previous.onJumpToWorkspace === next.onJumpToWorkspace &&
    sameAgentRow(previous.row, next.row),
);
