import {
  FolderGit2Icon,
  GitBranchIcon,
  HouseIcon,
  type LucideIcon,
  MonitorIcon,
  ServerIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";
import { resolveWorkspaceCardClassName, SIDEBAR_CARD_CLASS } from "../Sidebar.logic";

function EnvironmentHeader(props: {
  icon: LucideIcon;
  name: string;
  status: string;
  path?: string;
}) {
  const Icon = props.icon;
  return (
    <div className="flex min-w-0 items-center gap-2 px-1 text-[13px] font-medium text-foreground/90">
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{props.name}</span>
      <span className="shrink-0 text-xs font-normal text-muted-foreground">{props.status}</span>
      {props.path ? (
        <span className="ml-auto min-w-0 truncate text-xs font-normal text-muted-foreground">
          {props.path}
        </span>
      ) : null}
    </div>
  );
}

function ChatRows(props: { chats: readonly string[]; more?: number | undefined }) {
  return (
    <ul className="mt-0.5 grid gap-0.5 ps-5">
      {props.chats.map((chat) => (
        <li key={chat} data-sidebar-level="chat" className="truncate">
          {chat}
        </li>
      ))}
      {props.more ? <li data-sidebar-level="chat">{`${props.more} more chats`}</li> : null}
    </ul>
  );
}

function Worktree(props: {
  branch: string;
  selected: boolean;
  chats: readonly string[];
  more?: number;
}) {
  return (
    <li
      data-sidebar-level="worktree"
      data-selected={props.selected ? "true" : undefined}
      className={cn(
        resolveWorkspaceCardClassName({ isActive: false, isSelected: props.selected }),
        "px-2 py-1",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-foreground/90">
        <GitBranchIcon data-sidebar-icon aria-hidden className="size-3.5 shrink-0" />
        <span data-sidebar-label className="min-w-0 truncate">
          {props.branch}
        </span>
      </div>
      <ChatRows chats={props.chats} more={props.more} />
    </li>
  );
}

/**
 * The five sidebar levels from fixture data, drawn by the level rules of `index.css` and the
 * card states of `Sidebar.logic.ts`, so the theme editor shows what the left panel paints (R65).
 */
export function SidebarLevelsPreview() {
  return (
    <figure aria-label="Sidebar preview" className="m-0 mb-2 rounded-lg bg-sidebar-well p-2">
      <ul inert className="grid gap-1 text-foreground">
        <li
          data-sidebar-level="repo"
          data-sidebar-card="true"
          className={cn(SIDEBAR_CARD_CLASS, "grid gap-1 p-1")}
        >
          <div className="flex min-w-0 items-center gap-2 px-2 py-1 text-[13px] font-medium text-foreground/90">
            <FolderGit2Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">example-group/sample-project</span>
            <span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground">
              2 environments
            </span>
          </div>
          <ul className="grid gap-1">
            <li data-sidebar-level="environment" className="grid gap-1 py-1.5 ps-2.5 pe-1.5">
              <EnvironmentHeader
                icon={MonitorIcon}
                name="Local"
                status="Connected"
                path="~/sample-project"
              />
              <ul className="grid gap-1">
                <li data-sidebar-level="checkout" data-primary="" className="rounded-md px-2 py-1">
                  <div className="flex min-w-0 items-center gap-1.5 text-foreground/90">
                    <HouseIcon data-sidebar-icon aria-hidden className="size-3.5 shrink-0" />
                    <span data-sidebar-label className="min-w-0 truncate">
                      main
                    </span>
                    <span data-sidebar-badge className="shrink-0 px-1.5 text-xs leading-4">
                      primary
                    </span>
                  </div>
                  <ChatRows chats={["Plan the release notes"]} />
                </li>
                <Worktree branch="feature/sample" selected chats={["Fix the sign-in redirect"]} />
                <Worktree
                  branch="feature/sample-docs"
                  selected={false}
                  chats={["Update the setup guide"]}
                  more={3}
                />
              </ul>
            </li>
            <li
              data-sidebar-level="environment"
              className="grid gap-1 py-1.5 ps-2.5 pe-1.5 opacity-60"
            >
              <EnvironmentHeader icon={ServerIcon} name="example-server" status="Unavailable" />
            </li>
          </ul>
        </li>
      </ul>
    </figure>
  );
}
