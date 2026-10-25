import { formatChangeRequestNumber } from "@bibcode/shared/sourceControl";
import type {
  EnvironmentId,
  PipelinesRef,
  PipelinesRow,
  PullRequestsProviderKind,
  ScopedProjectRef,
} from "@bibcode/contracts";
import { Link } from "@tanstack/react-router";
import {
  CircleStopIcon,
  EllipsisIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  RotateCcwIcon,
  TagIcon,
} from "lucide-react";
import { memo } from "react";
import { useOpenPrLink } from "../../../lib/openPullRequestLink";
import { formatRelativeTimeLabel } from "../../../timestampFormat";
import { PullRequestsActor } from "../../pullRequests/shared/PullRequestsActor";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { PermissionButton } from "../../ui/permission-button";
import { PipelineStatusIcon } from "../shared/PipelineStatusIcon";
import {
  formatPipelineDuration,
  pipelineBadgeLabel,
  pipelineStatusText,
} from "../shared/pipelineStatus.logic";
import { usePipelineHoverPrefetch } from "../usePipelineHoverPrefetch";
import { pipelineRowActions } from "./pipelinesList.logic";

/** Every row has the same height, so the list never measures one. */
export const PIPELINES_ROW_HEIGHT = 64;

const HOST_NAMES: Record<PullRequestsProviderKind, string> = { github: "GitHub", gitlab: "GitLab" };

function RefLabel({
  value,
  provider,
}: {
  value: PipelinesRef;
  provider: PullRequestsProviderKind;
}) {
  const Icon =
    value.kind === "branch"
      ? GitBranchIcon
      : value.kind === "tag"
        ? TagIcon
        : value.kind === "merge_request"
          ? GitPullRequestIcon
          : null;
  const text =
    value.kind === "merge_request" && value.number !== null
      ? formatChangeRequestNumber(provider, value.number)
      : value.name;
  return (
    <span className="inline-flex min-w-0 items-center gap-1" title={value.name}>
      {Icon ? <Icon aria-hidden="true" className="size-3.5 shrink-0" /> : null}
      <span className="truncate">{text}</span>
    </span>
  );
}

function StageStrip({ stages }: { stages: NonNullable<PipelinesRow["stages"]> }) {
  return (
    <ol aria-label="Stages" className="flex min-w-0 items-center gap-0.5 overflow-hidden">
      {stages.map((stage) => {
        const label = `${stage.name}: ${pipelineStatusText(stage.status, stage.warnings).toLowerCase()}`;
        return (
          // GitLab stage names are unique within a pipeline.
          <li key={stage.name} aria-label={label} title={label} className="inline-flex">
            <PipelineStatusIcon status={stage.status} warnings={stage.warnings} />
          </li>
        );
      })}
    </ol>
  );
}

export interface PipelinesListRowProps {
  readonly row: PipelinesRow;
  readonly provider: PullRequestsProviderKind;
  readonly scope: { readonly environmentId: EnvironmentId; readonly cwd: string };
  readonly projectRef: ScopedProjectRef;
  readonly mutationsDisabledReason: string | null;
}

/**
 * One pipeline. Wide panels show GitLab's columns (status, pipeline, creator, stages,
 * actions); narrow ones fold status and creator into the two text lines. The whole
 * row opens the pipeline page; its actions stay separate tab stops above that link.
 */
export const PipelinesListRow = memo(function PipelinesListRow({
  row,
  provider,
  scope,
  projectRef,
  mutationsDisabledReason,
}: PipelinesListRowProps) {
  const hoverPrefetch = usePipelineHoverPrefetch({
    environmentId: scope.environmentId,
    cwd: scope.cwd,
    pipelineId: row.id,
  });
  const openLink = useOpenPrLink();
  const status = pipelineStatusText(row.status, row.warnings, row.reason);
  const title = row.title ?? row.ref.name;
  const age = Number.isFinite(Date.parse(row.createdAt))
    ? formatRelativeTimeLabel(row.createdAt)
    : null;
  const createdTitle = age === null ? undefined : new Date(row.createdAt).toLocaleString();
  const duration =
    row.durationSeconds === null ? null : formatPipelineDuration(row.durationSeconds);
  const actions = pipelineRowActions(row, mutationsDisabledReason);
  const hostName = HOST_NAMES[provider];
  return (
    <div
      role="listitem"
      aria-label={`${row.label} ${status}`}
      data-text-surface="background"
      className="relative flex min-w-0 items-center gap-3 border-b border-border px-4 hover:bg-accent/40"
      style={{ height: PIPELINES_ROW_HEIGHT }}
      {...hoverPrefetch}
    >
      <div className="flex w-6 shrink-0 justify-center @min-[720px]:hidden">
        <PipelineStatusIcon status={row.status} warnings={row.warnings} />
      </div>
      <div className="hidden w-36 shrink-0 flex-col gap-0.5 @min-[720px]:flex">
        <span className="flex items-center gap-1.5 text-sm">
          <PipelineStatusIcon status={row.status} warnings={row.warnings} />
          <span className="truncate">{status}</span>
        </span>
        <span className="flex gap-1 text-xs text-muted-foreground tabular-nums">
          {duration ? <span>{duration}</span> : null}
          {duration && age ? <span aria-hidden="true">·</span> : null}
          {age ? <span title={createdTitle}>{age}</span> : null}
        </span>
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="truncate text-sm font-medium">
          {/* The title's hit area covers the row, so the whole row opens the pipeline. */}
          <Link
            to="/project/$environmentId/$projectId/pipelines/$pipelineId"
            params={{ ...projectRef, pipelineId: String(row.id) }}
            title={title}
            className="underline-offset-2 after:absolute after:inset-0 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            {title}
          </Link>
        </p>
        <div className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-xs text-muted-foreground">
          <span className="shrink-0 font-medium text-foreground tabular-nums">{row.label}</span>
          <RefLabel value={row.ref} provider={provider} />
          {row.sha ? <span className="shrink-0 font-mono">{row.sha.slice(0, 8)}</span> : null}
          {age ? (
            <span className="shrink-0 @min-[720px]:hidden" title={createdTitle}>
              {age}
            </span>
          ) : null}
          {row.badges.map((badge) => (
            <Badge key={badge} variant="outline" size="sm" className="text-muted-foreground">
              {pipelineBadgeLabel(badge)}
            </Badge>
          ))}
        </div>
      </div>
      <div className="hidden w-40 shrink-0 truncate text-xs @min-[720px]:block">
        {row.actor ? <PullRequestsActor actor={row.actor} preferName /> : null}
      </div>
      <div className="w-16 shrink-0 @min-[720px]:w-40">
        {row.stages && row.stages.length > 0 ? <StageStrip stages={row.stages} /> : null}
      </div>
      <div className="relative z-10 flex shrink-0 items-center gap-1">
        {actions.retry ? (
          <PermissionButton
            variant="ghost"
            size="icon-sm"
            aria-label={`Retry pipeline ${row.label}`}
            permission={actions.retry}
          >
            <RotateCcwIcon aria-hidden="true" />
          </PermissionButton>
        ) : null}
        {actions.cancel ? (
          <PermissionButton
            variant="ghost"
            size="icon-sm"
            aria-label={`Cancel pipeline ${row.label}`}
            permission={actions.cancel}
          >
            <CircleStopIcon aria-hidden="true" />
          </PermissionButton>
        ) : null}
        {row.url ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`More actions for pipeline ${row.label}`}
                />
              }
            >
              <EllipsisIcon aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={(event) => openLink(event, row.url!)}>Open on {hostName}</MenuItem>
            </MenuPopup>
          </Menu>
        ) : null}
      </div>
    </div>
  );
});
