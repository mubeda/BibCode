import type { PullRequestsPipeline, PullRequestsPipelineStatus } from "@bibcode/contracts";
import {
  BanIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleHelpIcon,
  CircleMinusIcon,
  CirclePlayIcon,
  CircleXIcon,
  ClockIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useState } from "react";
import { Badge } from "../../ui/badge";
import { PullRequestsExternalLink } from "../shared/PullRequestsMarkdown";
import {
  isTerminalPipelineStatus,
  pipelineFinishedAnnouncement,
  pipelineKindLabel,
  pipelineShortSha,
  pipelineStatusLabel,
} from "./pullRequestsDetail.logic";

type PresentPipeline = Extract<PullRequestsPipeline, { _tag: "present" }>;

interface StatusIcon {
  readonly Icon: LucideIcon;
  readonly color: string;
  readonly spin?: true;
}

/** Shape carries the status as well as color (UI.md, Colors). */
const STATUS_ICONS: Record<PullRequestsPipelineStatus, StatusIcon> = {
  created: { Icon: CircleDashedIcon, color: "text-muted-foreground" },
  queued: { Icon: CircleDashedIcon, color: "text-muted-foreground" },
  waiting: { Icon: CircleDashedIcon, color: "text-muted-foreground" },
  running: { Icon: LoaderCircleIcon, color: "text-sky-600 dark:text-sky-400", spin: true },
  manual: { Icon: CirclePlayIcon, color: "text-foreground" },
  scheduled: { Icon: ClockIcon, color: "text-muted-foreground" },
  canceling: { Icon: BanIcon, color: "text-muted-foreground" },
  success: { Icon: CircleCheckIcon, color: "text-green-600 dark:text-green-400" },
  failed: { Icon: CircleXIcon, color: "text-red-600 dark:text-red-400" },
  canceled: { Icon: BanIcon, color: "text-muted-foreground" },
  skipped: { Icon: CircleMinusIcon, color: "text-muted-foreground" },
  unknown: { Icon: CircleHelpIcon, color: "text-muted-foreground" },
};
const WARNINGS_ICON: StatusIcon = {
  Icon: TriangleAlertIcon,
  color: "text-amber-600 dark:text-amber-400",
};

/** One pipeline or stage status, shared by the merge box and the Pipelines tab. */
export const PullRequestsPipelineStatusIcon = memo(function PullRequestsPipelineStatusIcon({
  status,
  warnings,
}: {
  status: PullRequestsPipelineStatus;
  warnings: boolean;
}) {
  const { Icon, color, spin } =
    status === "success" && warnings ? WARNINGS_ICON : STATUS_ICONS[status];
  const icon = <Icon aria-hidden="true" className={`size-4 shrink-0 ${color}`} />;
  // The wrapper spins, not the SVG, so the browser can hardware-accelerate it.
  return spin ? (
    <span aria-hidden="true" className="inline-flex shrink-0 motion-safe:animate-spin">
      {icon}
    </span>
  ) : (
    icon
  );
});

interface Shown {
  readonly id: number;
  readonly status: PullRequestsPipelineStatus;
  readonly settled: boolean;
}

/**
 * Announces a pipeline that finished while it was on screen, once. The first
 * copy shown, and a stored copy shown before this mount's own live read
 * answered, never announce. Tracked during render, as the detail view tracks
 * its painted copies, so no effect re-renders for it.
 */
function useFinishedAnnouncement(pipeline: PresentPipeline | null, settled: boolean): string {
  const [announcement, setAnnouncement] = useState("");
  const [shown, setShown] = useState<Shown | null>(null);
  const current: Shown | null = pipeline
    ? { id: pipeline.id, status: pipeline.status, settled }
    : null;
  if (
    shown?.id !== current?.id ||
    shown?.status !== current?.status ||
    shown?.settled !== current?.settled
  ) {
    if (
      shown !== null &&
      current !== null &&
      pipeline !== null &&
      shown.settled &&
      shown.id === current.id &&
      !isTerminalPipelineStatus(shown.status) &&
      isTerminalPipelineStatus(current.status)
    )
      setAnnouncement(
        pipelineFinishedAnnouncement(pipeline.id, pipeline.status, pipeline.warnings),
      );
    setShown(current);
  }
  return announcement;
}

const PipelineHeader = memo(function PipelineHeader({
  pipeline,
  branch,
}: {
  pipeline: PresentPipeline;
  branch: string;
}) {
  const sha = pipelineShortSha(pipeline);
  const status = pipelineStatusLabel(pipeline.status, pipeline.warnings);
  return (
    <div className="space-y-2">
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
        <PullRequestsPipelineStatusIcon status={pipeline.status} warnings={pipeline.warnings} />
        <span>
          {pipelineKindLabel(pipeline.kind)}{" "}
          {pipeline.url ? (
            <PullRequestsExternalLink href={pipeline.url}>
              <span className="font-semibold">#{pipeline.id}</span>
            </PullRequestsExternalLink>
          ) : (
            <span className="font-semibold">#{pipeline.id}</span>
          )}{" "}
          {status}
        </span>
        <span className="text-muted-foreground">
          {sha ? (
            <>
              · <span className="font-mono">{sha}</span> on {branch}
            </>
          ) : (
            <>on {branch}</>
          )}
        </span>
        {pipeline.isForHead === false ? (
          <Badge variant="warning" size="sm" title="This pipeline ran before the latest push.">
            Older commit
          </Badge>
        ) : null}
      </p>
      {pipeline.stages && pipeline.stages.length > 0 ? (
        <ol aria-label="Pipeline stages" className="flex flex-wrap gap-x-3 gap-y-1">
          {pipeline.stages.map((stage) => {
            const label = pipelineStatusLabel(stage.status, stage.warnings);
            return (
              <li
                // GitLab stage names are unique within a pipeline.
                key={stage.name}
                aria-label={`${stage.name}: ${label}`}
                title={label}
                className="inline-flex items-center gap-1 text-xs"
              >
                <PullRequestsPipelineStatusIcon status={stage.status} warnings={stage.warnings} />
                <span aria-hidden="true">{stage.name}</span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
});

/**
 * The gating pipeline: its kind, number, status, commit and branch, with the
 * stage strip, plus one polite live region for a pipeline finishing while
 * shown. `none` shows nothing; the readiness reasons say what is needed.
 */
export const PullRequestsPipelineSummary = memo(function PullRequestsPipelineSummary({
  pipeline,
  branch,
  settled,
}: {
  pipeline: PullRequestsPipeline;
  /** The request's source branch. */
  branch: string;
  /** This mount's live read has answered; earlier copies never announce. */
  settled: boolean;
}) {
  const present = pipeline._tag === "present" ? pipeline : null;
  const announcement = useFinishedAnnouncement(present, settled);
  return (
    <>
      {present ? (
        <PipelineHeader pipeline={present} branch={branch} />
      ) : pipeline._tag === "hidden" ? (
        <p className="text-sm text-muted-foreground">You can't view pipelines in this project.</p>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </>
  );
});
