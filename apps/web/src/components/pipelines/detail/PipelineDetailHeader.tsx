import { formatChangeRequestNumber } from "@bibcode/shared/sourceControl";
import type {
  PipelinesDetail,
  PipelinesRef,
  PullRequestsProviderKind,
  ScopedProjectRef,
} from "@bibcode/contracts";
import { Link } from "@tanstack/react-router";
import { GitBranchIcon, GitPullRequestIcon, TagIcon } from "lucide-react";
import { memo, type ReactNode } from "react";
import { formatRelativeTimeLabel } from "../../../timestampFormat";
import { PullRequestsActor } from "../../pullRequests/shared/PullRequestsActor";
import { RepositoryModuleExternalLink } from "../../repositoryModule/RepositoryModuleExternalLink";
import { PipelineActions } from "../actions/PipelineActions";
import type { RepositoryPermission } from "../actions/pipelineActions.logic";
import { pipelineRowActions } from "../list/pipelinesList.logic";
import { PipelineStatusIcon } from "../shared/PipelineStatusIcon";
import { formatPipelineDuration, pipelineStatusText } from "../shared/pipelineStatus.logic";
import { pipelineJobCount } from "./pipelineDetail.logic";

const HOST_NAMES: Record<PullRequestsProviderKind, string> = { github: "GitHub", gitlab: "GitLab" };

function Time({ at }: { at: string | null }) {
  if (at === null || !Number.isFinite(Date.parse(at))) return null;
  return (
    <time dateTime={at} title={new Date(at).toLocaleString()}>
      {formatRelativeTimeLabel(at)}
    </time>
  );
}

/** A branch or tag as text; a merge request opens its page in BiBCode. */
function PipelineRef({
  value,
  provider,
  projectRef,
}: {
  value: PipelinesRef;
  provider: PullRequestsProviderKind;
  projectRef: ScopedProjectRef;
}) {
  if (value.kind === "merge_request" && value.number !== null)
    return (
      <span className="inline-flex min-w-0 items-center gap-1">
        <GitPullRequestIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <Link
          to="/project/$environmentId/$projectId/pull-requests/$number"
          params={{ ...projectRef, number: String(value.number) }}
          search={{ tab: "conversation" }}
          title={value.name}
          className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
        >
          {formatChangeRequestNumber(provider, value.number)}
        </Link>
      </span>
    );
  const Icon = value.kind === "tag" ? TagIcon : value.kind === "branch" ? GitBranchIcon : null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1" title={value.name}>
      {Icon ? <Icon aria-hidden="true" className="size-3.5 shrink-0" /> : null}
      <span className="truncate">{value.name}</span>
    </span>
  );
}

/**
 * The pipeline's status, title and one line of who and when, then its commit, ref,
 * job count and times, with Retry, Cancel and the host link on the right.
 */
export const PipelineDetailHeader = memo(function PipelineDetailHeader({
  detail,
  provider,
  projectRef,
  mutationsDisabledReason,
  repositoryPermission,
  children,
}: {
  detail: PipelinesDetail;
  provider: PullRequestsProviderKind;
  projectRef: ScopedProjectRef;
  mutationsDisabledReason: string | null;
  /** The signed-in role, which tells GitHub's refusal of an action from a missing role. */
  repositoryPermission: RepositoryPermission | null;
  /** Controls the page adds beside the actions, such as GitHub's Attempt select. */
  children?: ReactNode;
}) {
  const { pipeline, commit } = detail;
  const shownStatus = PipelineActions.useShownStatus(pipeline);
  const status = pipelineStatusText(shownStatus, pipeline.warnings, pipeline.reason);
  const actions = pipelineRowActions(
    pipeline,
    mutationsDisabledReason,
    provider,
    repositoryPermission,
  );
  const target = { _tag: "pipeline", id: pipeline.id } as const;
  const jobs = pipelineJobCount(detail);
  const hostName = HOST_NAMES[provider];
  const name = provider === "gitlab" ? `Pipeline ${pipeline.label}` : pipeline.label;
  return (
    <header className="space-y-2 border-b border-border px-4 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <PipelineStatusIcon status={shownStatus} warnings={pipeline.warnings} />
            {status}
          </p>
          <h2 className="text-base font-semibold text-balance break-words">
            {pipeline.title ?? pipeline.ref.name}
          </h2>
          <p className="text-xs text-muted-foreground">
            {name} created <Time at={pipeline.createdAt} />
            {pipeline.actor ? (
              <>
                {" "}
                by <PullRequestsActor actor={pipeline.actor} preferName showInitials={false} />
              </>
            ) : null}
            {pipeline.finishedAt !== null ? (
              <>
                {" · finished "}
                <Time at={pipeline.finishedAt} />
              </>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {children}
          {actions.retry ? (
            <PipelineActions.Button
              variant="outline"
              size="sm"
              request={{ target, action: "retry" }}
              permission={actions.retry}
            >
              Retry
            </PipelineActions.Button>
          ) : null}
          {actions.retry && provider === "github" ? (
            <PipelineActions.Button
              variant="outline"
              size="sm"
              request={{ target, action: "retry_failed" }}
              permission={actions.retry}
            >
              Retry failed jobs
            </PipelineActions.Button>
          ) : null}
          {actions.cancel ? (
            <PipelineActions.Button
              variant="outline"
              size="sm"
              request={{ target, action: "cancel" }}
              permission={actions.cancel}
              from={pipeline.status}
            >
              Cancel
            </PipelineActions.Button>
          ) : null}
          {pipeline.url ? (
            <RepositoryModuleExternalLink href={pipeline.url} className="text-xs">
              Open on {hostName}
            </RepositoryModuleExternalLink>
          ) : null}
        </div>
      </div>
      <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-1.5">
          <dt className="sr-only">Commit</dt>
          <dd className="flex min-w-0 items-center gap-1.5">
            {commit.url ? (
              <RepositoryModuleExternalLink href={commit.url} className="font-mono text-foreground">
                {commit.sha.slice(0, 7)}
              </RepositoryModuleExternalLink>
            ) : (
              <span className="font-mono text-foreground">{commit.sha.slice(0, 7)}</span>
            )}
            {commit.title && commit.title !== pipeline.title ? (
              <span className="truncate">{commit.title}</span>
            ) : null}
          </dd>
        </div>
        <div className="flex min-w-0 items-center">
          <dt className="sr-only">Ref</dt>
          <dd className="min-w-0">
            <PipelineRef value={pipeline.ref} provider={provider} projectRef={projectRef} />
          </dd>
        </div>
        {jobs !== null ? (
          <div>
            <dt className="sr-only">Jobs</dt>
            <dd className="tabular-nums">
              {jobs.toLocaleString()} {jobs === 1 ? "job" : "jobs"}
            </dd>
          </div>
        ) : null}
        {pipeline.durationSeconds !== null ? (
          <div>
            <dt className="sr-only">Duration</dt>
            <dd className="tabular-nums">{formatPipelineDuration(pipeline.durationSeconds)}</dd>
          </div>
        ) : null}
        {pipeline.queuedSeconds !== null ? (
          <div>
            <dt className="sr-only">Queued</dt>
            <dd className="tabular-nums">
              Queued {formatPipelineDuration(pipeline.queuedSeconds)}
            </dd>
          </div>
        ) : null}
      </dl>
    </header>
  );
});
