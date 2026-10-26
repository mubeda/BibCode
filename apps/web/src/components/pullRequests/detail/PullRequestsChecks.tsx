import { getChangeRequestTerminologyForKind } from "@bibcode/shared/sourceControl";
import type {
  PullRequestsChecks as Checks,
  PullRequestsContext,
  PullRequestsPipeline,
  PullRequestsPipelineStatus,
  PullRequestsProviderKind,
} from "@bibcode/contracts";
import { Link } from "@tanstack/react-router";
import { memo } from "react";
import { useMergeRequestPipelineLinks } from "../../pipelines/shared/MergeRequestPipelineLinks";
import { PipelineStatusIcon } from "../../pipelines/shared/PipelineStatusIcon";
import { PullRequestsExternalLink } from "../shared/PullRequestsMarkdown";
import { checksSummaryLabel } from "./pullRequestsDetail.logic";
import { PullRequestsPipelineSummary } from "./PullRequestsPipelineSummary";
type CheckState = Checks["groups"][number]["checks"][number]["state"];
/** A check's state drawn with the shared pipeline icon, so jobs look the same everywhere. */
const STATES: Record<CheckState, PullRequestsPipelineStatus> = {
  pending: "running",
  success: "success",
  failure: "failed",
  cancelled: "canceled",
  skipped: "skipped",
  neutral: "skipped",
};
const HOST_NAMES: Record<PullRequestsProviderKind, string> = { github: "GitHub", gitlab: "GitLab" };
function duration(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${total % 60}s`;
}
const CheckGroup = memo(function CheckGroup({
  group,
  hostName,
}: {
  group: Checks["groups"][number];
  hostName: string;
}) {
  const links = useMergeRequestPipelineLinks();
  return (
    <details open className="rounded-lg border border-border">
      <summary className="cursor-pointer bg-muted/30 px-3 py-2 text-sm font-medium">
        {group.name} {group.checks.length}
      </summary>
      <ul>
        {group.checks.map((check) => {
          // In BiBCode when the Pipelines module can open the job; on the host otherwise.
          const jobPage = links.job(check);
          return (
            <li
              key={`${check.name}:${check.url ?? check.startedAt ?? ""}`}
              className="flex items-center gap-3 border-t border-border p-3 text-sm"
            >
              <span role="img" aria-label={check.state} title={check.state}>
                <PipelineStatusIcon status={STATES[check.state]} warnings={false} />
              </span>
              <span className="min-w-0 flex-1 break-words">
                {jobPage !== null ? (
                  <Link {...jobPage} className="text-primary underline underline-offset-4">
                    {check.name}
                  </Link>
                ) : check.url ? (
                  <PullRequestsExternalLink href={check.url}>{check.name}</PullRequestsExternalLink>
                ) : (
                  check.name
                )}
              </span>
              {jobPage !== null && check.url ? (
                <span className="shrink-0 text-xs">
                  <PullRequestsExternalLink href={check.url}>
                    Open on {hostName}
                  </PullRequestsExternalLink>
                </span>
              ) : null}
              {check.durationSeconds !== null ? (
                <span className="text-xs text-muted-foreground">
                  {duration(check.durationSeconds)}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </details>
  );
});
export const PullRequestsChecks = memo(function PullRequestsChecks({
  checks,
  context,
  pipeline = null,
  branch = "",
  settled = true,
}: {
  checks: Checks;
  context: Extract<PullRequestsContext, { status: "available" }>;
  /** The gating pipeline's summary (GitLab, newer servers); it replaces the bare link. */
  pipeline?: PullRequestsPipeline | null;
  /** The request's source branch, for the summary. */
  branch?: string;
  /** This mount's live read has answered; earlier copies never announce. */
  settled?: boolean;
}) {
  const empty = checks.groups.every((group) => group.checks.length === 0);
  return (
    <section
      aria-label={context.capabilities.vocabulary.checks}
      className="min-h-0 flex-1 space-y-3 overflow-auto p-4"
      data-text-surface="background"
    >
      {pipeline ? (
        <PullRequestsPipelineSummary pipeline={pipeline} branch={branch} settled={settled} />
      ) : checks.pipelineUrl ? (
        <p className="text-sm">
          <PullRequestsExternalLink href={checks.pipelineUrl}>
            Open pipeline
          </PullRequestsExternalLink>
        </p>
      ) : null}
      {checks.truncated ? (
        <p className="text-sm text-muted-foreground">
          Showing the first 100 jobs of a stage.{" "}
          {checks.pipelineUrl ? (
            <PullRequestsExternalLink href={checks.pipelineUrl}>
              Open the pipeline
            </PullRequestsExternalLink>
          ) : (
            "Open the pipeline"
          )}{" "}
          for the rest.
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">
        {empty
          ? context.capabilities.vocabulary.checks === "Pipelines"
            ? `No pipeline for this ${getChangeRequestTerminologyForKind(context.provider).singular}`
            : "No checks reported"
          : checksSummaryLabel(checks)}
      </p>
      {checks.groups.map((group) => (
        <CheckGroup key={group.name} group={group} hostName={HOST_NAMES[context.provider]} />
      ))}
    </section>
  );
});
