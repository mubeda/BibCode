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
import { memo, useLayoutEffect, useRef, useState } from "react";
import { useOpenPrLink } from "../../../lib/openPullRequestLink";
import { formatRelativeTimeLabel } from "../../../timestampFormat";
import { PullRequestsActor } from "../../pullRequests/shared/PullRequestsActor";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { PipelineActions } from "../actions/PipelineActions";
import type { RepositoryPermission } from "../actions/pipelineActions.logic";
import { PipelineStatusIcon } from "../shared/PipelineStatusIcon";
import {
  formatPipelineDuration,
  pipelineBadgeLabel,
  pipelineStatusText,
} from "../shared/pipelineStatus.logic";
import { usePipelineHoverPrefetch } from "../usePipelineHoverPrefetch";
import { AUTHOR_CELL_CLASS, PIPELINES_GRID_CLASS, useShownColumns } from "./PipelinesColumns";
import { visibleStageCount } from "./pipelinesColumns.logic";
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
  const listRef = useRef<HTMLOListElement>(null);
  const [shown, setShown] = useState(stages.length);
  // The column is resizable and folds by breakpoint, so the strip measures itself; only
  // this strip re-renders when its capacity changes.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = (width: number) => setShown(visibleStageCount(width, stages.length));
    measure(list.clientWidth);
    const observer = new ResizeObserver(([entry]) => measure(entry?.contentRect.width ?? 0));
    observer.observe(list);
    return () => observer.disconnect();
  }, [stages.length]);
  const hidden = stages.slice(shown);
  const labelOf = (stage: (typeof stages)[number]) =>
    `${stage.name}: ${pipelineStatusText(stage.status, stage.warnings).toLowerCase()}`;
  return (
    <ol
      ref={listRef}
      aria-label="Stages"
      className="flex min-w-0 items-center gap-0.5 overflow-hidden"
    >
      {stages.map((stage, index) => {
        const label = labelOf(stage);
        return (
          // GitLab stage names are unique within a pipeline. Stages that do not fit stay
          // in the tree for assistive technology and are counted by the "+N" below.
          <li
            key={stage.name}
            aria-label={label}
            title={label}
            className={index < shown ? "inline-flex" : "sr-only"}
          >
            <PipelineStatusIcon status={stage.status} warnings={stage.warnings} />
          </li>
        );
      })}
      {hidden.length > 0 ? (
        <li
          aria-hidden="true"
          title={hidden.map(labelOf).join("\n")}
          className="ms-0.5 shrink-0 text-xs text-muted-foreground tabular-nums"
        >
          +{hidden.length}
        </li>
      ) : null}
    </ol>
  );
}

export interface PipelinesListRowProps {
  readonly row: PipelinesRow;
  readonly provider: PullRequestsProviderKind;
  readonly scope: { readonly environmentId: EnvironmentId; readonly cwd: string };
  readonly projectRef: ScopedProjectRef;
  readonly mutationsDisabledReason: string | null;
  /** The signed-in role, which tells GitHub's refusal of an action from a missing role. */
  readonly repositoryPermission: RepositoryPermission | null;
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
  repositoryPermission,
}: PipelinesListRowProps) {
  const hoverPrefetch = usePipelineHoverPrefetch({
    environmentId: scope.environmentId,
    cwd: scope.cwd,
    pipelineId: row.id,
  });
  const openLink = useOpenPrLink();
  const shownStatus = PipelineActions.useShownStatus(row);
  const status = pipelineStatusText(shownStatus, row.warnings, row.reason);
  const title = row.title ?? row.ref.name;
  const age = Number.isFinite(Date.parse(row.createdAt))
    ? formatRelativeTimeLabel(row.createdAt)
    : null;
  const createdTitle = age === null ? undefined : new Date(row.createdAt).toLocaleString();
  const duration =
    row.durationSeconds === null ? null : formatPipelineDuration(row.durationSeconds);
  const actions = pipelineRowActions(row, mutationsDisabledReason, provider, repositoryPermission);
  const target = { _tag: "pipeline", id: row.id } as const;
  const hostName = HOST_NAMES[provider];
  const { author, stages } = useShownColumns();
  return (
    <div
      role="row"
      aria-label={`${row.label} ${status}`}
      data-text-surface="background"
      className={`${PIPELINES_GRID_CLASS} relative min-w-0 border-b border-border hover:bg-accent/40`}
      style={{ height: PIPELINES_ROW_HEIGHT }}
      {...hoverPrefetch}
    >
      <div role="cell" className="min-w-0">
        <span className="flex justify-center @min-[720px]:hidden">
          <PipelineStatusIcon status={shownStatus} warnings={row.warnings} />
        </span>
        <span className="hidden flex-col gap-0.5 @min-[720px]:flex">
          <span className="flex items-center gap-1.5 text-sm">
            <PipelineStatusIcon status={shownStatus} warnings={row.warnings} />
            <span className="truncate">{status}</span>
          </span>
          <span className="flex gap-1 text-xs text-muted-foreground tabular-nums">
            {duration ? <span>{duration}</span> : null}
            {duration && age ? <span aria-hidden="true">·</span> : null}
            {age ? <span title={createdTitle}>{age}</span> : null}
          </span>
        </span>
      </div>
      <div role="cell" className="min-w-0 space-y-0.5">
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
      {author ? (
        <div role="cell" className={`${AUTHOR_CELL_CLASS} min-w-0 truncate text-xs`}>
          {row.actor ? <PullRequestsActor actor={row.actor} preferName /> : null}
        </div>
      ) : null}
      {stages ? (
        <div role="cell" className="min-w-0">
          {row.stages && row.stages.length > 0 ? <StageStrip stages={row.stages} /> : null}
        </div>
      ) : null}
      {/* The cell has a fixed track, so a row without Retry or Cancel keeps the columns aligned. */}
      <div role="cell" className="relative z-10 flex items-center justify-end gap-1">
        {actions.retry ? (
          <PipelineActions.Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Retry pipeline ${row.label}`}
            request={{ target, action: "retry" }}
            permission={actions.retry}
            icon={<RotateCcwIcon aria-hidden="true" />}
          />
        ) : null}
        {actions.cancel ? (
          <PipelineActions.Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Cancel pipeline ${row.label}`}
            request={{ target, action: "cancel" }}
            permission={actions.cancel}
            from={row.status}
            icon={<CircleStopIcon aria-hidden="true" />}
          />
        ) : null}
        {row.url || (actions.retry && provider === "github") ? (
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
              {actions.retry && provider === "github" ? (
                <PipelineActions.Item
                  request={{ target, action: "retry_failed" }}
                  permission={actions.retry}
                >
                  Retry failed jobs
                </PipelineActions.Item>
              ) : null}
              {row.url ? (
                <MenuItem onClick={(event) => openLink(event, row.url!)}>
                  Open on {hostName}
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
        ) : null}
      </div>
    </div>
  );
});
