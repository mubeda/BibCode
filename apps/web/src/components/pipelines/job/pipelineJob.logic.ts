import type {
  PipelinesDetail,
  PipelinesJob,
  PipelinesJobDetail,
  PipelinesJobPermissions,
  PipelinesSubscribeInput,
} from "@bibcode/contracts";
import type { PipelinesFilters } from "../../../pipelinesStore";
import { buildPipelinesListInput, listSnapshotInput } from "../list/pipelinesList.logic";

/**
 * The job route's `readSnapshot` and `subscribe` input: the project's remembered list
 * key, so the job page shares the list's poller, with the job's pipeline (polled) and
 * the job itself (stored row only; the poller never reads jobs).
 */
export function jobSnapshotInput(
  filters: PipelinesFilters,
  cwd: string,
  pipelineId: number,
  jobId: number,
): PipelinesSubscribeInput {
  return {
    ...listSnapshotInput(buildPipelinesListInput(filters, cwd)),
    pipelineId,
    jobId,
  };
}

export interface JobInPipeline {
  readonly job: PipelinesJob;
  readonly stage: string;
}

/** The job as its pipeline's detail describes it: the poller keeps that copy current. */
export function findPipelineJob(
  detail: PipelinesDetail | null,
  jobId: number,
): JobInPipeline | null {
  for (const stage of detail?.stages ?? [])
    for (const group of stage.groups)
      for (const job of group.jobs) if (job.id === jobId) return { job, stage: stage.name };
  return null;
}

/**
 * The job's status, timing and permissions: the pipeline detail's copy when it has the
 * job (polled while it runs), otherwise the job read's own. A job read newer by
 * `revision` (GitHub re-reads a running job more often than its run) gives the status
 * and timing; the permissions stay the pipeline's, the host's answer for this account.
 */
export function shownJob(
  detail: PipelinesDetail | null,
  jobDetail: PipelinesJobDetail | null,
  jobId: number,
): PipelinesJob | null {
  const fromPipeline = findPipelineJob(detail, jobId)?.job ?? null;
  if (fromPipeline === null) return jobDetail?.job ?? null;
  if (jobDetail === null || detail === null || jobDetail.revision <= detail.revision)
    return fromPipeline;
  return { ...jobDetail.job, permissions: fromPipeline.permissions };
}

/** Seconds a finished step took, or `null` while it runs or without both times. */
export function stepDurationSeconds(step: {
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}): number | null {
  if (step.startedAt === null || step.completedAt === null) return null;
  const seconds = (Date.parse(step.completedAt) - Date.parse(step.startedAt)) / 1_000;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export interface RelatedStage {
  readonly name: string;
  readonly jobs: readonly PipelinesJob[];
}

/** Every stage of the pipeline with its jobs, groups flattened, in the pipeline's order. */
export function relatedStages(detail: PipelinesDetail | null): readonly RelatedStage[] {
  return (detail?.stages ?? []).map((stage) => ({
    name: stage.name,
    jobs: stage.groups.flatMap((group) => group.jobs),
  }));
}

export interface JobActionPermission {
  readonly allowed: boolean;
  readonly reason: string | null;
}

const DENIED: Record<keyof PipelinesJobPermissions, string> = {
  retry: "You don't have permission to retry this job.",
  cancel: "You don't have permission to cancel this job.",
  play: "You don't have permission to run this job.",
};

function jobPermission(
  action: keyof PipelinesJobPermissions,
  permissions: PipelinesJobPermissions,
  mutationsDisabledReason: string | null,
): JobActionPermission {
  // The host's refusal comes first: no server update lets a refused account act.
  if (permissions[action] === "denied") return { allowed: false, reason: DENIED[action] };
  if (mutationsDisabledReason !== null) return { allowed: false, reason: mutationsDisabledReason };
  return { allowed: true, reason: null };
}

/**
 * The job's Retry, Cancel and Play, each `null` when it does not apply: Retry for a
 * finished job that did not pass, Cancel for one that can still run, Play for a manual
 * job. A disabled action says why.
 */
export function pipelineJobActions(
  job: Pick<PipelinesJob, "status" | "terminal" | "permissions" | "kind">,
  mutationsDisabledReason: string | null,
): {
  readonly retry: JobActionPermission | null;
  readonly cancel: JobActionPermission | null;
  readonly play: JobActionPermission | null;
} {
  const manual = job.status === "manual";
  return {
    retry:
      job.terminal && !manual && job.status !== "success" && job.kind === "build"
        ? jobPermission("retry", job.permissions, mutationsDisabledReason)
        : null,
    cancel:
      !job.terminal && !manual
        ? jobPermission("cancel", job.permissions, mutationsDisabledReason)
        : null,
    play: manual ? jobPermission("play", job.permissions, mutationsDisabledReason) : null,
  };
}

/**
 * GitLab's artifact pages for a job, on the job's own web URL (which the server built
 * on the project's origin): Download for the archive, Browse for its files.
 */
export function gitlabArtifactLinks(jobUrl: string | null): {
  readonly download: string;
  readonly browse: string;
} | null {
  if (jobUrl === null) return null;
  const base = jobUrl.replace(/\/+$/, "");
  return { download: `${base}/artifacts/download`, browse: `${base}/artifacts/browse` };
}

/** `12.4 MB`, `812 KB`, `96 B`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

/** Seconds since `startedAt`, for a running job's Elapsed row. */
export function elapsedSeconds(startedAt: string | null, now: number): number | null {
  if (startedAt === null) return null;
  const started = Date.parse(startedAt);
  return Number.isFinite(started) ? Math.max(0, (now - started) / 1_000) : null;
}
