import type { PipelinesDetailStage, PipelinesJob, PipelinesJobGroup } from "@bibcode/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, CircleStopIcon, PlayIcon, RotateCcwIcon } from "lucide-react";
import { memo, useState, type ReactNode } from "react";
import { cn } from "../../../lib/utils";
import { RepositoryModuleExternalLink } from "../../repositoryModule/RepositoryModuleExternalLink";
import { PipelineActions } from "../actions/PipelineActions";
import { PipelineStatusIcon } from "../shared/PipelineStatusIcon";
import { formatPipelineDuration, pipelineStatusText } from "../shared/pipelineStatus.logic";
import { usePipelineLinks } from "./PipelineLinks";
import { pipelineJobAction } from "./pipelineDetail.logic";

const ACTION_ICONS = { play: PlayIcon, cancel: CircleStopIcon, retry: RotateCcwIcon } as const;
const ROW_CLASS =
  "flex min-h-9 min-w-0 items-center gap-2 rounded-md px-2 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring";

/** The job's own page: in BiBCode once the view provides one, on the host until then. */
function JobLink({ job, children }: { job: PipelinesJob; children: ReactNode }) {
  const route = usePipelineLinks().jobLink(job.id);
  const className = cn(ROW_CLASS, "flex-1 no-underline");
  if (route !== null)
    return (
      <Link {...route} className={className}>
        {children}
      </Link>
    );
  if (job.url === null) return <span className={className}>{children}</span>;
  return (
    <RepositoryModuleExternalLink href={job.url} className={className}>
      {children}
    </RepositoryModuleExternalLink>
  );
}

const JobRow = memo(function JobRow({
  job,
  mutationsDisabledReason,
}: {
  job: PipelinesJob;
  mutationsDisabledReason: string | null;
}) {
  const action = pipelineJobAction(job, mutationsDisabledReason);
  const ActionIcon = action === null ? null : ACTION_ICONS[action.kind];
  const status = pipelineStatusText(job.status, job.warnings, job.reason);
  return (
    <li className="flex min-w-0 items-center gap-1">
      <JobLink job={job}>
        <span role="img" aria-label={status} title={status} className="inline-flex">
          <PipelineStatusIcon status={job.status} warnings={job.warnings} />
        </span>
        <span className="min-w-0 flex-1 truncate" title={job.name}>
          {job.name}
        </span>
        {job.durationSeconds !== null ? (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {formatPipelineDuration(job.durationSeconds)}
          </span>
        ) : null}
      </JobLink>
      {job.downstreamUrl !== null ? (
        <RepositoryModuleExternalLink href={job.downstreamUrl} className="shrink-0 text-xs">
          Downstream pipeline
        </RepositoryModuleExternalLink>
      ) : null}
      {action !== null && ActionIcon !== null ? (
        <PipelineActions.Button
          variant="ghost"
          size="icon-sm"
          aria-label={action.label}
          request={{ target: { _tag: "job", id: job.id }, action: action.kind }}
          permission={action.permission}
          icon={<ActionIcon aria-hidden="true" />}
        />
      ) : null}
    </li>
  );
});

/** A parallel group (`rspec 3`): one row that expands to its jobs. */
function JobGroupRow({
  group,
  mutationsDisabledReason,
}: {
  group: PipelinesJobGroup;
  mutationsDisabledReason: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const status = pipelineStatusText(group.status, false);
  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-expanded={expanded}
        className={cn(ROW_CLASS, "w-full text-left")}
        onClick={() => setExpanded((open) => !open)}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground motion-safe:transition-transform",
            expanded && "rotate-90",
          )}
        />
        <span role="img" aria-label={status} title={status} className="inline-flex">
          <PipelineStatusIcon status={group.status} warnings={false} />
        </span>
        <span className="min-w-0 flex-1 truncate">{group.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{group.size}</span>
      </button>
      {expanded ? (
        <ul aria-label={`${group.name} jobs`} className="ms-5">
          {group.jobs.map((job) => (
            <JobRow key={job.id} job={job} mutationsDisabledReason={mutationsDisabledReason} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function jobCountLabel(stage: PipelinesDetailStage): string {
  let count = 0;
  for (const group of stage.groups) count += Math.max(group.size, group.jobs.length);
  return `${count.toLocaleString()} ${count === 1 ? "job" : "jobs"}`;
}

/** One stage: its status, name and job count, then a row per job or parallel group. */
const PipelineStage = memo(function PipelineStage({
  stage,
  mutationsDisabledReason,
}: {
  stage: PipelinesDetailStage;
  mutationsDisabledReason: string | null;
}) {
  const status = pipelineStatusText(stage.status, stage.warnings);
  return (
    <li className="flex min-w-0 flex-col gap-1 @min-[720px]/pipeline:w-64 @min-[720px]/pipeline:shrink-0">
      <h3 className="flex min-w-0 items-center gap-2 px-2 text-sm font-medium">
        <span role="img" aria-label={status} title={status} className="inline-flex">
          <PipelineStatusIcon status={stage.status} warnings={stage.warnings} />
        </span>
        <span className="min-w-0 truncate">{stage.name}</span>
        <span className="ms-auto shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
          {jobCountLabel(stage)}
        </span>
      </h3>
      <ul aria-label={`${stage.name} jobs`} className="min-w-0">
        {stage.groups.map((group) =>
          group.size > 1 ? (
            <JobGroupRow
              key={`group:${group.name}`}
              group={group}
              mutationsDisabledReason={mutationsDisabledReason}
            />
          ) : (
            group.jobs.map((job) => (
              <JobRow key={job.id} job={job} mutationsDisabledReason={mutationsDisabledReason} />
            ))
          ),
        )}
      </ul>
    </li>
  );
});

/**
 * A pipeline's stages in the host's order: side by side and scrolling sideways on a
 * wide panel (the `pipeline` container, 720 px and up), stacked on a narrow one. One
 * tree either way, so a 1,000-job run renders its rows once.
 */
export const PipelineStageColumns = memo(function PipelineStageColumns({
  stages,
  mutationsDisabledReason,
}: {
  stages: readonly PipelinesDetailStage[];
  mutationsDisabledReason: string | null;
}) {
  return (
    <ol
      aria-label="Stages"
      data-text-surface="background"
      className="flex min-w-0 flex-col gap-4 @min-[720px]/pipeline:flex-row @min-[720px]/pipeline:overflow-x-auto @min-[720px]/pipeline:pb-2"
    >
      {stages.map((stage) => (
        // Stage names are unique within a pipeline; GitHub has the one "Jobs" column.
        <PipelineStage
          key={stage.name}
          stage={stage}
          mutationsDisabledReason={mutationsDisabledReason}
        />
      ))}
    </ol>
  );
});
