import type { PipelinesDetail, PullRequestsProviderKind } from "@bibcode/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { pipelinesEnvironment } from "../../../state/pipelines";
import { usePullRequestsQuery } from "../../pullRequests/shared/usePullRequestsQuery";
import { useRepositoryModule } from "../../repositoryModule/RepositoryModule";
import { Button } from "../../ui/button";
import { JobReadError, operationError } from "../job/PipelineJobView";
import { jobLogSource, shownJob } from "../job/pipelineJob.logic";
import { pipelineJobLink } from "../job/pipelineJobRoute";
import { JobLog } from "../log/JobLog";
import { PipelineStatusIcon } from "../shared/PipelineStatusIcon";
import { pipelineStatusText } from "../shared/pipelineStatus.logic";
import { useRateLimitCountdown } from "../shared/useRateLimitCountdown";

const HOST_NAMES: Record<PullRequestsProviderKind, string> = { github: "GitHub", gitlab: "GitLab" };

/**
 * One job's log beside the pipeline's stages. The job's status comes from the pipeline
 * detail the page keeps current; one job read names the attempt, erasure and raw log
 * link. Its job page keeps the details, steps and actions, and is one link away.
 * Focus moves to the panel's heading when it opens; Escape or Close hand it back.
 */
export function PipelineJobLogPanel({
  detail,
  jobId,
  onClose,
}: {
  detail: PipelinesDetail;
  jobId: number;
  onClose: () => void;
}) {
  const {
    context,
    state: { scope },
    meta: { projectRef },
  } = useRepositoryModule();
  const navigate = useNavigate();
  const isGitlab = context.provider === "gitlab";
  const hostName = HOST_NAMES[context.provider];
  const jobTarget = useMemo(
    () => ({
      environmentId: scope.environmentId,
      input: { cwd: scope.cwd, jobId, refresh: "user" as const },
    }),
    [jobId, scope.cwd, scope.environmentId],
  );
  const jobQuery = usePullRequestsQuery(
    useMemo(() => pipelinesEnvironment.getJob(jobTarget), [jobTarget]),
  );
  const jobDetail = jobQuery.data;
  const job = shownJob(detail, jobDetail, jobId);
  const { source } = jobLogSource(job, jobDetail, isGitlab);
  const error = operationError(jobQuery);
  const waitSeconds = useRateLimitCountdown(error, jobQuery.refresh);
  const pipelineId = detail.pipeline.id;
  const jobPage = pipelineJobLink({
    environmentId: projectRef.environmentId,
    projectId: projectRef.projectId,
    pipelineId,
    jobId,
  });
  // A line link opens the job's own page at that line: its address is the permalink.
  const onLineLink = useCallback(
    (offset: number) =>
      void navigate(
        pipelineJobLink({
          environmentId: projectRef.environmentId,
          projectId: projectRef.projectId,
          pipelineId,
          jobId,
          at: offset,
        }),
      ),
    [jobId, navigate, pipelineId, projectRef.environmentId, projectRef.projectId],
  );
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const heading = headingRef.current;
    const panel = heading?.closest("aside");
    if (!heading || !panel) return;
    // Stacked under the stages the panel opens below the fold: bring it into view, as a
    // deep link does. Side by side it is already visible.
    const stacked = getComputedStyle(panel.parentElement ?? panel).flexDirection === "column";
    // Instant, like the deep link: a smooth scroll started during mount is cut short by the
    // layout settling (measured: it never moved), and it needs no reduced-motion branch.
    if (stacked) panel.scrollIntoView({ block: "start", behavior: "instant" });
    // Never take focus from a field the reader is typing in (a filter, say).
    const active = document.activeElement;
    const typing =
      active instanceof HTMLElement &&
      (active.isContentEditable || active.matches("input, textarea, select"));
    if (!typing) heading.focus({ preventScroll: true });
  }, []);
  const status = job ? pipelineStatusText(job.status, job.warnings, job.reason) : "";
  return (
    <aside
      aria-labelledby="pipeline-job-log-heading"
      data-text-surface="background"
      className="flex h-[70vh] min-h-0 min-w-0 shrink-0 flex-col border-t border-panel-separator @min-[960px]/pipeline:h-auto @min-[960px]/pipeline:w-[45%] @min-[960px]/pipeline:border-t-0 @min-[960px]/pipeline:border-l"
      onKeyDown={(event) => {
        // The log's search uses Escape to return to the log; only an unclaimed one closes.
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="flex min-w-0 items-center gap-2 border-b border-panel-separator px-3 py-2">
        <h2
          id="pipeline-job-log-heading"
          ref={headingRef}
          tabIndex={-1}
          className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold outline-none"
        >
          {job ? <PipelineStatusIcon status={job.status} warnings={job.warnings} /> : null}
          <span className="truncate">{job?.name ?? `Job #${jobId}`}</span>
          {status ? (
            <span className="shrink-0 font-normal text-muted-foreground">{status}</span>
          ) : null}
        </h2>
        <Link {...jobPage} className="shrink-0 text-xs underline underline-offset-4">
          Open job page
        </Link>
        <Button variant="ghost" size="icon-sm" aria-label="Close log" onClick={onClose}>
          <XIcon aria-hidden="true" />
        </Button>
      </div>
      {error !== null && jobDetail === null ? (
        <JobReadError
          error={error}
          hostName={hostName}
          url={job?.url ?? null}
          waitSeconds={waitSeconds}
          onRetry={jobQuery.refresh}
          back={null}
        />
      ) : source === null ? null : (
        <JobLog.Provider
          source={source}
          scope={scope}
          initialOffset={null}
          rawLogUrl={jobDetail?.rawLogUrl ?? null}
          hostName={hostName}
          onLineLink={onLineLink}
        >
          <JobLog.Toolbar>
            <JobLog.Search />
            <JobLog.TimestampsToggle />
            <JobLog.WrapToggle />
            <JobLog.SectionsToggle />
            <JobLog.ScrollButtons />
            <JobLog.RawLink />
          </JobLog.Toolbar>
          <JobLog.LoadEarlier />
          <JobLog.Lines />
          <JobLog.Status />
        </JobLog.Provider>
      )}
    </aside>
  );
}
