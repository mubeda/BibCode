import type { PipelinesDetailStage, PipelinesJob, PipelinesJobGroup } from "@bibcode/contracts";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ChevronRightIcon,
  CircleStopIcon,
  PlayIcon,
  RotateCcwIcon,
  WrapTextIcon,
} from "lucide-react";
import { memo, useState, type CSSProperties, type ReactNode } from "react";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useResizableWidth } from "~/hooks/useResizableWidth";
import { cn } from "../../../lib/utils";
import { RepositoryModuleExternalLink } from "../../repositoryModule/RepositoryModuleExternalLink";
import { Toggle } from "../../ui/toggle";
import { PipelineActions } from "../actions/PipelineActions";
import { PipelineColumnSeparator } from "../shared/PipelineColumnSeparator";
import { PipelineStatusIcon } from "../shared/PipelineStatusIcon";
import { formatPipelineDuration, pipelineStatusText } from "../shared/pipelineStatus.logic";
import { usePipelineLinks } from "./PipelineLinks";
import { pipelineJobAction } from "./pipelineDetail.logic";

const ACTION_ICONS = { play: PlayIcon, cancel: CircleStopIcon, retry: RotateCcwIcon } as const;
/** A name wraps while its stage column has room and truncates only at the 256 px minimum. */
const NAME_CLASS = "min-w-0 flex-1 break-words @max-[257px]/stage:truncate";
const ROW_CLASS =
  "flex min-h-9 min-w-0 items-center gap-2 rounded-md px-2 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring";

/**
 * The job's own page: in BiBCode once the view provides one, on the host until then.
 * Where the view shows logs in place, a plain click opens the job's log there instead.
 */
function JobLink({ job, children }: { job: PipelinesJob; children: ReactNode }) {
  const { jobLink, selectJob, selectedJobId } = usePipelineLinks();
  const route = jobLink(job.id);
  const selected = selectedJobId === job.id;
  const className = cn(ROW_CLASS, "flex-1 no-underline", selected && "bg-accent");
  if (route !== null)
    return (
      <Link
        {...route}
        className={className}
        aria-current={selected ? "true" : undefined}
        onClick={
          selectJob === undefined
            ? undefined
            : (event) => {
                const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
                if (event.button !== 0 || modified) return;
                event.preventDefault();
                selectJob(job.id);
              }
        }
      >
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
        <span className={NAME_CLASS} title={job.name}>
          {job.name}
          {job.needs != null && job.needs.length > 0 ? (
            <span className="block text-xs text-muted-foreground">
              Needs: {job.needs.join(", ")}
            </span>
          ) : null}
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
        <span className={NAME_CLASS}>{group.name}</span>
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

/** Columns never get narrower than this (`min-w-64`); the row scrolls sideways instead. */
const STAGE_MIN_WIDTH = 256;
/** The widest a stage column grows: the user's setting, one value for every column. */
const STAGE_WIDTH = { default: 480, min: STAGE_MIN_WIDTH, max: 960 } as const;
const STAGE_WIDTH_KEY = "bibcode:pipelines-stage-width";
const STAGE_WRAP_KEY = "bibcode:pipelines-stage-wrap";

/**
 * One stage: its status, name and job count, then a row per job or parallel group. At
 * the wide step it grows from 256 px up to the shared `--pipeline-stage-max`.
 * `separator` is the column-width handle, passed to the first stage only.
 */
const PipelineStage = memo(function PipelineStage({
  stage,
  mutationsDisabledReason,
  separator,
}: {
  stage: PipelinesDetailStage;
  mutationsDisabledReason: string | null;
  separator: ReactNode;
}) {
  const status = pipelineStatusText(stage.status, stage.warnings);
  return (
    <li className="@container/stage relative flex min-w-0 flex-col gap-1 @min-[720px]/pipeline:min-w-64 @min-[720px]/pipeline:max-w-(--pipeline-stage-max) @min-[720px]/pipeline:flex-1 @min-[720px]/pipeline:basis-0">
      {separator}
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
 * A pipeline's stages in the host's order: side by side on a wide panel (the `pipeline`
 * container, 720 px and up), stacked on a narrow one. Wide columns share the row, each
 * between 256 px and the user's width (a separator on the first column sets it), and
 * the row scrolls sideways only when the stages at 256 px do not fit, or, with Wrap
 * stages on, puts the stages that do not fit on more rows. One tree either way, so a
 * 1,000-job run renders its rows once.
 */
export const PipelineStageColumns = memo(function PipelineStageColumns({
  stages,
  mutationsDisabledReason,
  controls = null,
}: {
  stages: readonly PipelinesDetailStage[];
  mutationsDisabledReason: string | null;
  /** More view controls, shown before Wrap stages. */
  controls?: ReactNode;
}) {
  const { width, handlers, commitWidth } = useResizableWidth({
    storageKey: STAGE_WIDTH_KEY,
    defaultWidth: STAGE_WIDTH.default,
    minWidth: STAGE_WIDTH.min,
    maxWidth: STAGE_WIDTH.max,
    edge: "right",
  });
  const [wrap, setWrap] = useLocalStorage(STAGE_WRAP_KEY, false, Schema.Boolean);
  const separator = (
    <PipelineColumnSeparator
      label="Resize stage columns"
      value={width}
      min={STAGE_WIDTH.min}
      max={STAGE_WIDTH.max}
      handlers={handlers}
      onResize={commitWidth}
      onReset={() => commitWidth(STAGE_WIDTH.default)}
      className="hidden @min-[720px]/pipeline:block"
    />
  );
  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-2 empty:hidden">
        {controls}
        {/* Stacked stages (below 720 px) never scroll sideways, so the switch shows only beside them. */}
        <Toggle
          size="xs"
          variant="outline"
          pressed={wrap}
          onPressedChange={setWrap}
          className="hidden @min-[720px]/pipeline:inline-flex"
        >
          <WrapTextIcon aria-hidden="true" />
          Wrap stages
        </Toggle>
      </div>
      <ol
        aria-label="Stages"
        data-text-surface="background"
        style={{ "--pipeline-stage-max": `${width}px` } as CSSProperties}
        className={cn(
          "flex min-w-0 flex-col gap-4 @min-[720px]/pipeline:flex-row",
          wrap
            ? "@min-[720px]/pipeline:flex-wrap"
            : "@min-[720px]/pipeline:overflow-x-auto @min-[720px]/pipeline:pb-2",
        )}
      >
        {stages.map((stage, index) => (
          // Stage names are unique within a pipeline; GitHub has the one "Jobs" column.
          <PipelineStage
            key={stage.name}
            stage={stage}
            mutationsDisabledReason={mutationsDisabledReason}
            separator={index === 0 ? separator : null}
          />
        ))}
      </ol>
    </>
  );
});
