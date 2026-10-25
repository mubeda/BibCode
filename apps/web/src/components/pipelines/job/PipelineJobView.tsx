import { squashAtomCommandFailure } from "@bibcode/client-runtime/state/runtime";
import {
  PullRequestsOperationError,
  type PipelinesDetail,
  type PipelinesJobDetail,
  type PipelinesRefusal,
  type PullRequestsProviderKind,
} from "@bibcode/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ChevronRightIcon,
  CircleStopIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { PipelinesFilters } from "../../../pipelinesStore";
import { pipelinesEnvironment } from "../../../state/pipelines";
import { useEnvironmentQuery, type EnvironmentQueryView } from "../../../state/query";
import { formatRelativeTimeLabel } from "../../../timestampFormat";
import { PullRequestsContextRefresh } from "../../pullRequests/pullRequestsContextRefresh";
import { usePullRequestsQuery } from "../../pullRequests/shared/usePullRequestsQuery";
import { useDocumentVisible } from "../../pullRequests/useDocumentVisible";
import { RepositoryModule, useRepositoryModule } from "../../repositoryModule/RepositoryModule";
import { RepositoryModuleExternalLink } from "../../repositoryModule/RepositoryModuleExternalLink";
import { keepNewestCopy, type KeptCopy } from "../../repositoryModule/snapshotDisplay.logic";
import { useVisibleModuleRefresh } from "../../repositoryModule/useVisibleModuleRefresh";
import { Button } from "../../ui/button";
import { PermissionButton } from "../../ui/permission-button";
import { Skeleton } from "../../ui/skeleton";
import { PipelineActions, type PipelineActionOutcome } from "../actions/PipelineActions";
import { pipelineActionDestination } from "../actions/pipelineActions.logic";
import { JobLog, type JobLogSource } from "../log/JobLog";
import { PipelineStatusIcon } from "../shared/PipelineStatusIcon";
import { pipelineStatusText } from "../shared/pipelineStatus.logic";
import { useRateLimitCountdown } from "../shared/useRateLimitCountdown";
import { detailTimerIntervalMs } from "../detail/pipelineDetail.logic";
import { PipelineJobDetails } from "./PipelineJobDetails";
import { PipelineJobSteps } from "./PipelineJobSteps";
import {
  findPipelineJob,
  jobSnapshotInput,
  pipelineJobActions,
  shownJob,
} from "./pipelineJob.logic";
import { PIPELINE_JOB_ROUTE, pipelineJobLink } from "./pipelineJobRoute";

const HOST_NAMES: Record<PullRequestsProviderKind, string> = { github: "GitHub", gitlab: "GitLab" };
/** A running pipeline is re-read this often while its stream is down (GitLab's poller cadence). */
export const JOB_PIPELINE_TIMER_MS = 10_000;
/** A running GitHub job is re-read this often, for its steps' progress. */
export const GITHUB_JOB_TIMER_MS = 10_000;
/** A GitHub job page re-reads its run three times less often than the run's own page. */
const GITHUB_JOB_PAGE_RUN_FACTOR = 3;
const NO_STEPS: PipelinesJobDetail["steps"] = [];
const isOperationError = Schema.is(PullRequestsOperationError);

function operationError(query: EnvironmentQueryView<unknown>) {
  const failure =
    query.emission._tag === "Failure" ? squashAtomCommandFailure(query.emission) : null;
  return isOperationError(failure) ? failure : null;
}

/** Announces the job reaching a finished status while the page is open, once. */
function useJobFinishedAnnouncement(name: string | null, status: string, terminal: boolean | null) {
  const [announcement, setAnnouncement] = useState("");
  const previous = useRef<boolean | null>(null);
  useEffect(() => {
    if (previous.current === false && terminal === true && name !== null)
      setAnnouncement(`Job ${name} finished: ${status}.`);
    previous.current = terminal;
  }, [name, status, terminal]);
  return announcement;
}

/**
 * One job: its header, its log, and its details. The job's status and permissions come
 * from its pipeline's detail, which GitLab's poller keeps current while the page is
 * visible (the page subscribes with the pipeline); the job read is repeated only once,
 * when the job finishes, because its runner and artifacts change only then. GitHub has
 * no poller and serves a job's log only once it completes: while a job runs its page
 * re-reads the job every 10 s for its steps and the run every 30 s per page of jobs,
 * and shows the steps where the log will be.
 */
export function PipelineJobView({
  filters,
  pipelineId,
  jobId,
  at,
}: {
  filters: PipelinesFilters;
  pipelineId: number;
  jobId: number;
  at: number | null;
}) {
  const {
    context,
    state: { scope },
    meta: { projectRef, mutationsDisabledReason },
  } = useRepositoryModule();
  const navigate = useNavigate();
  const { environmentId, cwd } = scope;
  const isGitlab = context.provider === "gitlab";
  const hostName = HOST_NAMES[context.provider];

  const getTarget = useMemo(
    () => ({
      environmentId,
      input: { cwd, pipelineId, attempt: null, refresh: "user" as const },
    }),
    [cwd, environmentId, pipelineId],
  );
  const detailQuery = usePullRequestsQuery(
    useMemo(() => pipelinesEnvironment.get(getTarget), [getTarget]),
  );
  const jobTarget = useMemo(
    () => ({ environmentId, input: { cwd, jobId, refresh: "user" as const } }),
    [cwd, environmentId, jobId],
  );
  const jobQuery = usePullRequestsQuery(
    useMemo(() => pipelinesEnvironment.getJob(jobTarget), [jobTarget]),
  );
  const snapshotTarget = useMemo(
    () => ({ environmentId, input: jobSnapshotInput(filters, cwd, pipelineId, jobId) }),
    [cwd, environmentId, filters, jobId, pipelineId],
  );
  // Both hosts paint the stored rows; only GitLab subscribes to changes.
  const snapshotQuery = useEnvironmentQuery(
    useMemo(() => pipelinesEnvironment.readSnapshot(snapshotTarget), [snapshotTarget]),
  );
  const visible = useDocumentVisible();
  const subscribeQuery = useEnvironmentQuery(
    useMemo(
      () => (isGitlab && visible ? pipelinesEnvironment.subscribe(snapshotTarget) : null),
      [isGitlab, snapshotTarget, visible],
    ),
  );
  // Any success on the stream stands the pipeline timer down until it fails or waits.
  const paused = isGitlab && subscribeQuery.emission._tag === "Success";
  // The poller's read of this job's pipeline was refused and its stored row dropped:
  // the refusal replaces the job on screen until a Refresh reads the host again.
  const [refusal, setRefusal] = useState<{
    readonly target: typeof getTarget;
    readonly code: PipelinesRefusal;
  } | null>(null);
  // Each event is a new object: a refusal is taken from the event that carries it.
  const [seenChange, setSeenChange] = useState<typeof subscribeQuery.data>(null);
  if (subscribeQuery.data !== seenChange) {
    setSeenChange(subscribeQuery.data);
    if (subscribeQuery.data?.refused)
      setRefusal({ target: getTarget, code: subscribeQuery.data.refused });
  }
  const refused = refusal !== null && refusal.target === getTarget ? refusal.code : null;
  const applySubscribedChange = useEffectEvent(
    (changed: NonNullable<typeof subscribeQuery.data>) => {
      // The poller stored the new pipeline row: paint it, with no host read.
      if (changed.pipeline) snapshotQuery.revalidate();
    },
  );
  useEffect(() => {
    if (subscribeQuery.data) applySubscribedChange(subscribeQuery.data);
  }, [subscribeQuery.data]);

  // The newest copy by revision across live, stored and polled, so the screen never
  // moves back whichever read answers last.
  const [keptDetail, setKeptDetail] = useState<KeptCopy<PipelinesDetail> | null>(null);
  const detailChoice = keepNewestCopy(keptDetail, pipelineId, [
    detailQuery.data,
    snapshotQuery.data?.detail?.payload,
  ]);
  if (detailChoice.kept !== keptDetail) setKeptDetail(detailChoice.kept);
  const detail = refused === null ? detailChoice.shown : null;
  const [keptJob, setKeptJob] = useState<KeptCopy<PipelinesJobDetail> | null>(null);
  const jobChoice = keepNewestCopy(keptJob, jobId, [
    jobQuery.data,
    snapshotQuery.data?.job?.payload,
  ]);
  if (jobChoice.kept !== keptJob) setKeptJob(jobChoice.kept);
  const jobDetail = refused === null ? jobChoice.shown : null;
  const job = shownJob(detail, jobDetail, jobId);
  const stage = findPipelineJob(detail, jobId)?.stage ?? job?.stage ?? null;
  const pipeline = detail?.pipeline ?? null;

  // The pipeline is re-read on a timer until it finishes: on GitLab only while its
  // stream is down; on GitHub, which has no stream, at a third of its page's cadence
  // and only while this job runs, since a finished job's page shows nothing new.
  const revalidateDetail = detailQuery.revalidate;
  const timerRead = useCallback(() => {
    pipelinesEnvironment.requestTimerRead(getTarget);
    revalidateDetail();
  }, [getTarget, revalidateDetail]);
  useVisibleModuleRefresh({
    enabled:
      pipeline !== null && !pipeline.terminal && (isGitlab || (job !== null && !job.terminal)),
    succeeded: detailQuery.data !== null && detailQuery.error === null && !detailQuery.isPending,
    paused,
    intervalMs:
      isGitlab || detail === null
        ? JOB_PIPELINE_TIMER_MS
        : GITHUB_JOB_PAGE_RUN_FACTOR * detailTimerIntervalMs("github", detail, false),
    revalidate: timerRead,
  });
  // A running GitHub job's steps are its only progress BiBCode can show.
  const revalidateJob = jobQuery.revalidate;
  const jobTimerRead = useCallback(() => {
    pipelinesEnvironment.requestTimerRead(jobTarget);
    revalidateJob();
  }, [jobTarget, revalidateJob]);
  useVisibleModuleRefresh({
    enabled: !isGitlab && job !== null && !job.terminal,
    succeeded: jobQuery.data !== null && jobQuery.error === null && !jobQuery.isPending,
    intervalMs: GITHUB_JOB_TIMER_MS,
    revalidate: jobTimerRead,
  });

  // The runner, artifacts and erasure change only when the job finishes: read once then.
  const terminal = job?.terminal ?? null;
  const previousTerminal = useRef<boolean | null>(null);
  const onTerminalChange = useEffectEvent((next: boolean | null) => {
    if (previousTerminal.current === false && next === true) jobQuery.refresh();
    previousTerminal.current = next;
  });
  useEffect(() => {
    onTerminalChange(terminal);
  }, [terminal]);

  const statusText = job ? pipelineStatusText(job.status, job.warnings, job.reason) : "";
  const announcement = useJobFinishedAnnouncement(job?.name ?? null, statusText, terminal);

  const jobError = operationError(jobQuery);
  const detailError = operationError(detailQuery);
  const refreshContext = useContext(PullRequestsContextRefresh);
  useEffect(() => {
    if (jobError?.code === "not_authenticated" || detailError?.code === "not_authenticated")
      refreshContext?.();
  }, [detailError, jobError, refreshContext]);
  const refreshAll = useCallback(() => {
    setRefusal(null);
    jobQuery.refresh();
    detailQuery.refresh();
  }, [detailQuery, jobQuery]);
  const limited = jobError?.code === "rate_limited" ? jobError : detailError;
  const waitSeconds = useRateLimitCountdown(
    limited?.code === "rate_limited" ? limited : null,
    refreshAll,
  );

  const erased = jobDetail?.erased ?? false;
  const started = job !== null && (job.startedAt !== null || job.status === "running");
  // GitHub serves a job's log once it completes; until then its own page has it.
  const sourceKind =
    job === null
      ? null
      : erased
        ? "erased"
        : job.terminal
          ? "complete"
          : isGitlab
            ? "live"
            : started
              ? "on_host"
              : "not_started";
  // The log is keyed by the job's attempt, which GitHub's job read names: wait for it,
  // so the log is read once.
  const logAttempt = jobDetail?.attempt ?? null;
  const waitsForAttempt = !isGitlab && jobDetail === null;
  const jobUrl = job?.url ?? null;
  const source: JobLogSource | null =
    sourceKind === null
      ? null
      : sourceKind === "erased"
        ? { _tag: "unavailable", reason: "erased", url: null }
        : sourceKind === "on_host"
          ? { _tag: "unavailable", reason: "live_on_host", url: jobUrl }
          : sourceKind === "not_started"
            ? { _tag: "unavailable", reason: "not_started", url: null }
            : waitsForAttempt
              ? null
              : sourceKind === "live"
                ? { _tag: "live", jobId, attempt: logAttempt, started }
                : { _tag: "complete", jobId, attempt: logAttempt };
  const steps = jobDetail?.steps ?? NO_STEPS;
  const { environmentId: routeEnvironmentId, projectId } = projectRef;
  const onLineLink = useCallback(
    (offset: number) => {
      void navigate({
        to: PIPELINE_JOB_ROUTE,
        params: {
          environmentId: routeEnvironmentId,
          projectId,
          pipelineId: String(pipelineId),
          jobId: String(jobId),
        },
        search: { at: offset },
        replace: true,
      });
    },
    [jobId, navigate, pipelineId, projectId, routeEnvironmentId],
  );

  const actions = job
    ? pipelineJobActions(
        job,
        mutationsDisabledReason,
        context.provider,
        context.repositoryPermission,
      )
    : null;
  // A GitLab job retry opens the new job; a GitHub re-run is the run's next attempt,
  // whose page opens. Anything else re-reads the job and its pipeline.
  const revalidateBoth = useCallback(() => {
    revalidateJob();
    revalidateDetail();
  }, [revalidateDetail, revalidateJob]);
  const onActionSettled = useCallback(
    ({ request, result }: PipelineActionOutcome) => {
      const destination =
        result === null
          ? null
          : pipelineActionDestination({
              provider: context.provider,
              request,
              result,
              shown: { pipelineId, attempt: null, jobId },
            });
      if (destination?.kind === "job") {
        void navigate(
          pipelineJobLink({
            environmentId: routeEnvironmentId,
            projectId,
            pipelineId: destination.pipelineId,
            jobId: destination.jobId,
          }),
        );
        return;
      }
      if (destination?.kind === "pipeline") {
        void navigate({
          to: "/project/$environmentId/$projectId/pipelines/$pipelineId",
          params: {
            environmentId: routeEnvironmentId,
            projectId,
            pipelineId: String(destination.pipelineId),
          },
        });
        return;
      }
      revalidateBoth();
    },
    [context.provider, jobId, navigate, pipelineId, projectId, revalidateBoth, routeEnvironmentId],
  );
  const jobTargetRef = { _tag: "job", id: jobId } as const;
  const backedOff = waitSeconds !== null;
  const startedLabel =
    job?.startedAt && Number.isFinite(Date.parse(job.startedAt))
      ? formatRelativeTimeLabel(job.startedAt)
      : null;
  const refusedError = useMemo(
    () =>
      refused === null
        ? null
        : new PullRequestsOperationError({
            operation: "pipelines.subscribe",
            code: refused,
            message:
              refused === "forbidden"
                ? "You can't view this pipeline."
                : "This pipeline no longer exists.",
            hostDetail: null,
            retryable: false,
          }),
    [refused],
  );
  const blockingError = refusedError ?? (job === null ? jobError : null);

  return (
    <PipelineActions.Provider
      scope={scope}
      provider={context.provider}
      revision={detail?.revision ?? null}
      onSettled={onActionSettled}
    >
      <section
        aria-label="Job"
        className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background"
      >
        <RepositoryModule.Header>
          <RepositoryModule.Identity />
          <RepositoryModule.WorktreeSelect />
          <PermissionButton
            variant="outline"
            size="sm"
            onClick={refreshAll}
            permission={
              backedOff
                ? { allowed: false, reason: "The host asked BiBCode to wait before reading again." }
                : { allowed: true, reason: null }
            }
          >
            <RefreshCwIcon aria-hidden="true" />
            Refresh
          </PermissionButton>
          {job?.url ? (
            <RepositoryModuleExternalLink href={job.url} className="text-xs">
              Open on {hostName}
            </RepositoryModuleExternalLink>
          ) : null}
        </RepositoryModule.Header>
        <div className="border-b border-border px-4 py-3">
          <nav
            aria-label="Breadcrumb"
            className="mb-1 flex items-center gap-1 text-xs text-muted-foreground"
          >
            <Link
              to="/project/$environmentId/$projectId/pipelines"
              params={{ environmentId: routeEnvironmentId, projectId }}
              className="underline-offset-4 hover:text-foreground hover:underline"
            >
              Pipelines
            </Link>
            <ChevronRightIcon aria-hidden="true" className="size-3" />
            {pipeline?.url ? (
              <RepositoryModuleExternalLink
                href={pipeline.url}
                className="no-underline hover:underline"
              >
                {pipeline.label}
              </RepositoryModuleExternalLink>
            ) : (
              <span className="tabular-nums">{pipeline?.label ?? `#${pipelineId}`}</span>
            )}
          </nav>
          {job === null ? (
            blockingError === null ? (
              <div role="status" className="space-y-2">
                <span className="sr-only">Loading the job…</span>
                <Skeleton className="h-6 w-56" />
                <Skeleton className="h-4 w-80" />
              </div>
            ) : null
          ) : (
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1 space-y-0.5">
                <h1 className="flex min-w-0 items-center gap-2 text-base font-semibold">
                  <PipelineStatusIcon status={job.status} warnings={job.warnings} />
                  <span className="truncate">{job.name}</span>
                  <span className="shrink-0 text-sm font-normal text-muted-foreground">
                    {statusText}
                  </span>
                </h1>
                <p className="text-xs text-muted-foreground">
                  Job #{job.id}
                  {stage ? ` · stage ${stage}` : ""}
                  {startedLabel ? ` · started ${startedLabel}` : ""}
                </p>
              </div>
              {actions ? (
                <div className="flex shrink-0 items-center gap-1">
                  {actions.retry ? (
                    <PipelineActions.Button
                      size="sm"
                      variant="outline"
                      request={{ target: jobTargetRef, action: "retry" }}
                      permission={actions.retry}
                      icon={<RotateCcwIcon aria-hidden="true" />}
                    >
                      Retry
                    </PipelineActions.Button>
                  ) : null}
                  {actions.cancel ? (
                    <PipelineActions.Button
                      size="sm"
                      variant="outline"
                      request={{ target: jobTargetRef, action: "cancel" }}
                      permission={actions.cancel}
                      icon={<CircleStopIcon aria-hidden="true" />}
                    >
                      Cancel
                    </PipelineActions.Button>
                  ) : null}
                  {actions.play ? (
                    <PipelineActions.Button
                      size="sm"
                      variant="outline"
                      request={{ target: jobTargetRef, action: "play" }}
                      permission={actions.play}
                      icon={<PlayIcon aria-hidden="true" />}
                    >
                      Run
                    </PipelineActions.Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
          <p aria-live="polite" className="sr-only">
            {announcement}
          </p>
        </div>
        {blockingError !== null ? (
          <JobReadError
            error={blockingError}
            hostName={hostName}
            url={snapshotQuery.data?.job?.payload.job.url ?? null}
            waitSeconds={waitSeconds}
            onRetry={refreshAll}
            back={
              <Link
                to="/project/$environmentId/$projectId/pipelines"
                params={{ environmentId: routeEnvironmentId, projectId }}
                className="text-xs underline underline-offset-4"
              >
                Back to pipelines
              </Link>
            }
          />
        ) : source === null || job === null ? null : (
          <JobLog.Provider
            source={source}
            scope={scope}
            initialOffset={at}
            rawLogUrl={jobDetail?.rawLogUrl ?? null}
            hostName={hostName}
            onLineLink={onLineLink}
          >
            <div className="@container flex min-h-0 flex-1">
              <JobBody
                details={
                  <PipelineJobDetails
                    job={job}
                    jobDetail={jobDetail}
                    detail={detail}
                    detailError={detailError?.message ?? detailQuery.error}
                    provider={context.provider}
                  >
                    {sourceKind === "on_host" ? null : <PipelineJobSteps steps={steps} />}
                  </PipelineJobDetails>
                }
                inPlaceOfLog={
                  sourceKind === "on_host" && steps.length > 0 ? (
                    <div className="overflow-auto p-4 text-xs" data-text-surface="background">
                      <PipelineJobSteps steps={steps} />
                    </div>
                  ) : null
                }
              />
            </div>
          </JobLog.Provider>
        )}
      </section>
    </PipelineActions.Provider>
  );
}

/**
 * The log beside the details on wide panels; on narrow ones a Details disclosure above
 * it. `inPlaceOfLog` replaces the log while the host keeps it (a running GitHub job).
 */
function JobBody({ details, inPlaceOfLog }: { details: ReactNode; inPlaceOfLog: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col @min-[960px]:flex-row">
      <div className="border-b border-border px-4 py-1.5 @min-[960px]:hidden">
        <Button
          size="xs"
          variant="ghost"
          aria-expanded={open}
          aria-controls="pipeline-job-details"
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={open ? "rotate-90 transition-transform" : "transition-transform"}
          />
          Details
        </Button>
      </div>
      <aside
        id="pipeline-job-details"
        aria-label="Job details"
        data-text-surface="background"
        className={`${open ? "block" : "hidden"} max-h-[50%] shrink-0 overflow-auto border-b border-border @min-[960px]:order-last @min-[960px]:block @min-[960px]:max-h-none @min-[960px]:w-80 @min-[960px]:border-b-0 @min-[960px]:border-l @min-[960px]:border-panel-separator`}
      >
        {details}
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {inPlaceOfLog ? (
          <>
            <JobLog.Status />
            {inPlaceOfLog}
          </>
        ) : (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}

function JobReadError({
  error,
  hostName,
  url,
  waitSeconds,
  onRetry,
  back,
}: {
  error: PullRequestsOperationError;
  hostName: string;
  url: string | null;
  waitSeconds: number | null;
  onRetry: () => void;
  /** The way back to the list, for a job that no longer exists. */
  back: ReactNode;
}) {
  const message =
    error.code === "forbidden"
      ? "You can't view this job."
      : error.code === "not_found"
        ? "This job no longer exists."
        : error.message;
  return (
    <div role="alert" className="space-y-2 p-4 text-sm">
      <p>{message}</p>
      {waitSeconds !== null ? (
        <p className="text-xs text-muted-foreground tabular-nums">
          Trying again in {waitSeconds} s.
        </p>
      ) : error.hostDetail ? (
        <p className="text-xs text-muted-foreground">{error.hostDetail}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {error.code !== "forbidden" && error.code !== "not_found" ? (
          <PermissionButton
            size="sm"
            variant="outline"
            onClick={onRetry}
            permission={
              waitSeconds !== null
                ? { allowed: false, reason: "The host asked BiBCode to wait before reading again." }
                : { allowed: true, reason: null }
            }
          >
            Retry
          </PermissionButton>
        ) : null}
        {error.code === "forbidden" && url ? (
          <RepositoryModuleExternalLink href={url} className="text-xs">
            Open on {hostName}
          </RepositoryModuleExternalLink>
        ) : null}
        {error.code === "not_found" ? back : null}
      </div>
    </div>
  );
}
