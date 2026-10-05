import { MonitorIcon } from "lucide-react";
import { memo } from "react";

import { EnvironmentStatusDot } from "./EnvironmentRail";
import type { EnvironmentCardIdentity } from "./repositoryView.logic";

/** Replaces the project favicon and name when a project node is shown inside a repository group. */
export const EnvironmentCardHeader = memo(function EnvironmentCardHeader({
  identity,
  workspaceRoot,
}: {
  readonly identity: EnvironmentCardIdentity;
  readonly workspaceRoot: string;
}) {
  return (
    <span
      className="flex min-w-0 flex-1 items-center gap-2"
      data-testid={`environment-card-header-${identity.environmentId}`}
    >
      <span className="relative inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold text-foreground">
        {identity.isLocal ? <MonitorIcon aria-hidden className="size-3.5" /> : identity.avatar}
        <EnvironmentStatusDot
          status={identity.status}
          className="absolute -right-0.5 -bottom-0.5"
        />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-foreground/90">
            {identity.label}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{identity.statusLabel}</span>
        </span>
        <span className="truncate font-mono text-xs text-muted-foreground" title={workspaceRoot}>
          {workspaceRoot}
        </span>
      </span>
    </span>
  );
});
