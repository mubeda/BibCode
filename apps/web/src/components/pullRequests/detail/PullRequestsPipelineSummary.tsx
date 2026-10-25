import type { PullRequestsPipeline } from "@bibcode/contracts";
import { Link } from "@tanstack/react-router";
import { memo } from "react";
import { useMergeRequestPipelineLinks } from "../../pipelines/shared/MergeRequestPipelineLinks";
import { PipelineStatusIcon } from "../../pipelines/shared/PipelineStatusIcon";
import { useFinishedAnnouncement } from "../../pipelines/shared/useFinishedAnnouncement";
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

const PipelineHeader = memo(function PipelineHeader({
  pipeline,
  branch,
}: {
  pipeline: PresentPipeline;
  branch: string;
}) {
  const sha = pipelineShortSha(pipeline);
  const status = pipelineStatusLabel(pipeline.status, pipeline.warnings);
  const pipelinePage = useMergeRequestPipelineLinks().pipeline(pipeline.id);
  return (
    <div className="space-y-2">
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
        <PipelineStatusIcon status={pipeline.status} warnings={pipeline.warnings} />
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
        {pipelinePage !== null ? (
          <Link {...pipelinePage} className="text-primary underline underline-offset-4">
            View pipeline
          </Link>
        ) : null}
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
                <PipelineStatusIcon status={stage.status} warnings={stage.warnings} />
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
  const announcement = useFinishedAnnouncement(
    present
      ? {
          id: present.id,
          status: present.status,
          terminal: isTerminalPipelineStatus(present.status),
          message: pipelineFinishedAnnouncement(present.id, present.status, present.warnings),
        }
      : null,
    settled,
  );
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
