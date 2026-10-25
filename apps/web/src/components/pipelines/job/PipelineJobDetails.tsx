import type {
  PipelinesArtifact,
  PipelinesDetail,
  PipelinesJob,
  PipelinesJobDetail,
  PullRequestsProviderKind,
} from "@bibcode/contracts";
import { Link } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { formatRelativeTimeLabel } from "../../../timestampFormat";
import { useRepositoryModule } from "../../repositoryModule/RepositoryModule";
import { RepositoryModuleExternalLink } from "../../repositoryModule/RepositoryModuleExternalLink";
import { Badge } from "../../ui/badge";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { PipelineStatusIcon } from "../shared/PipelineStatusIcon";
import { formatPipelineDuration, pipelineStatusText } from "../shared/pipelineStatus.logic";
import {
  elapsedSeconds,
  formatBytes,
  gitlabArtifactLinks,
  relatedStages,
} from "./pipelineJob.logic";
import { pipelineJobLink } from "./pipelineJobRoute";

/** The current time, ticking each second while `ticking`, for a running job's Elapsed. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return now;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 py-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function When({ at }: { at: string | null }) {
  if (at === null || !Number.isFinite(Date.parse(at))) return <>—</>;
  return <span title={new Date(at).toLocaleString()}>{formatRelativeTimeLabel(at)}</span>;
}

/** An expiry is in the future, so it reads as a date, with the exact time on hover. */
function ExpiryDate({ at }: { at: string }) {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return <>—</>;
  const date = new Date(time);
  return (
    <time dateTime={at} title={date.toLocaleString()}>
      {date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
    </time>
  );
}

function ArtifactItem({
  artifact,
  provider,
  jobUrl,
}: {
  artifact: PipelinesArtifact;
  provider: PullRequestsProviderKind;
  jobUrl: string | null;
}) {
  const links = provider === "gitlab" && !artifact.expired ? gitlabArtifactLinks(jobUrl) : null;
  return (
    <li className="space-y-0.5">
      <p className="truncate font-medium" title={artifact.name}>
        {artifact.name}
      </p>
      <p className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
        {artifact.sizeBytes !== null ? (
          <span className="tabular-nums">{formatBytes(artifact.sizeBytes)}</span>
        ) : null}
        {artifact.expired ? (
          <Badge variant="outline" size="sm" className="text-muted-foreground">
            Expired
          </Badge>
        ) : artifact.expiresAt ? (
          <span>
            expires <ExpiryDate at={artifact.expiresAt} />
          </span>
        ) : null}
      </p>
      {links ? (
        <p className="flex gap-3">
          <RepositoryModuleExternalLink href={links.download}>
            Download
          </RepositoryModuleExternalLink>
          <RepositoryModuleExternalLink href={links.browse}>Browse</RepositoryModuleExternalLink>
        </p>
      ) : artifact.url && !artifact.expired ? (
        <RepositoryModuleExternalLink href={artifact.url}>
          Open on {provider === "github" ? "GitHub" : "GitLab"}
        </RepositoryModuleExternalLink>
      ) : null}
    </li>
  );
}

/** Every stage's jobs, one stage at a time, each an in-app link to its job page. */
function RelatedJobs({ detail, current }: { detail: PipelinesDetail; current: PipelinesJob }) {
  const {
    meta: { projectRef },
  } = useRepositoryModule();
  const stages = relatedStages(detail);
  const [chosen, setChosen] = useState(current.stage);
  const stage = stages.find((candidate) => candidate.name === chosen) ?? stages[0];
  if (stage === undefined) return null;
  return (
    <section aria-labelledby="pipeline-job-related" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id="pipeline-job-related" className="font-semibold">
          Related jobs
        </h2>
        {stages.length > 1 ? (
          <div className="w-36">
            <Select
              modal={false}
              items={stages.map((candidate) => ({ value: candidate.name, label: candidate.name }))}
              value={stage.name}
              onValueChange={(value) => {
                if (value !== null) setChosen(value);
              }}
            >
              <SelectTrigger aria-label="Stage" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {stages.map((candidate) => (
                  <SelectItem key={candidate.name} value={candidate.name}>
                    {candidate.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        ) : null}
      </div>
      <ul aria-label={`${stage.name} jobs`} className="space-y-0.5">
        {stage.jobs.map((job) => {
          const status = pipelineStatusText(job.status, job.warnings, job.reason);
          const here = job.id === current.id;
          return (
            <li key={job.id}>
              <Link
                {...pipelineJobLink({
                  environmentId: projectRef.environmentId,
                  projectId: projectRef.projectId,
                  pipelineId: detail.pipeline.id,
                  jobId: job.id,
                })}
                aria-current={here ? "page" : undefined}
                aria-label={`${job.name}: ${status.toLowerCase()}`}
                className={`flex min-h-7 items-center gap-2 rounded-md px-1.5 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring ${
                  here ? "bg-accent font-medium" : ""
                }`}
              >
                <PipelineStatusIcon status={job.status} warnings={job.warnings} />
                <span className="min-w-0 flex-1 truncate">{job.name}</span>
                {job.durationSeconds !== null ? (
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {formatPipelineDuration(job.durationSeconds)}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The job's facts beside its log: timing, runner, source, tags, artifacts, commit,
 * pipeline and the pipeline's other jobs. Timeout is not shown: neither host's public
 * API returns it.
 */
export function PipelineJobDetails({
  job,
  jobDetail,
  detail,
  detailError,
  provider,
}: {
  job: PipelinesJob;
  jobDetail: PipelinesJobDetail | null;
  detail: PipelinesDetail | null;
  detailError: string | null;
  provider: PullRequestsProviderKind;
}) {
  const running = !job.terminal && job.startedAt !== null;
  const now = useNow(running);
  const elapsed = running ? elapsedSeconds(job.startedAt, now) : null;
  const duration = running ? elapsed : job.durationSeconds;
  const pipeline = detail?.pipeline ?? null;
  const commit = detail?.commit ?? null;
  return (
    <div className="space-y-4 p-4 text-xs">
      <dl>
        <Row label={running ? "Elapsed" : "Duration"}>
          {duration === null ? "—" : formatPipelineDuration(duration)}
        </Row>
        <Row label="Finished">
          <When at={job.finishedAt} />
        </Row>
        <Row label="Queued">
          {job.queuedSeconds === null ? "—" : formatPipelineDuration(job.queuedSeconds)}
        </Row>
        {jobDetail?.runner ? (
          <Row label="Runner">
            <span title={jobDetail.runner.description ?? undefined}>{jobDetail.runner.name}</span>
          </Row>
        ) : null}
        {jobDetail?.source ? (
          <Row label="Source">
            <code className="font-mono">{jobDetail.source}</code>
          </Row>
        ) : null}
        {jobDetail && jobDetail.tags.length > 0 ? (
          <Row label="Tags">
            <span className="flex flex-wrap gap-1">
              {jobDetail.tags.map((tag) => (
                <Badge key={tag} variant="outline" size="sm" className="text-muted-foreground">
                  {tag}
                </Badge>
              ))}
            </span>
          </Row>
        ) : null}
        {commit ? (
          <Row label="Commit">
            {commit.url ? (
              <RepositoryModuleExternalLink href={commit.url} className="font-mono">
                {commit.sha.slice(0, 8)}
              </RepositoryModuleExternalLink>
            ) : (
              <span className="font-mono">{commit.sha.slice(0, 8)}</span>
            )}
            {commit.title ? (
              <span className="block text-muted-foreground">{commit.title}</span>
            ) : null}
          </Row>
        ) : null}
        {pipeline ? (
          <Row label="Pipeline">
            <span className="inline-flex items-center gap-1">
              <PipelineStatusIcon status={pipeline.status} warnings={pipeline.warnings} />
              {pipeline.url ? (
                <RepositoryModuleExternalLink href={pipeline.url} className="tabular-nums">
                  {pipeline.label}
                </RepositoryModuleExternalLink>
              ) : (
                <span className="tabular-nums">{pipeline.label}</span>
              )}
            </span>
            <span className="block truncate text-muted-foreground" title={pipeline.ref.name}>
              {pipeline.ref.name}
            </span>
          </Row>
        ) : null}
      </dl>
      {jobDetail && jobDetail.artifacts.length > 0 ? (
        <section aria-labelledby="pipeline-job-artifacts" className="space-y-2">
          <h2 id="pipeline-job-artifacts" className="font-semibold">
            Artifacts
          </h2>
          <ul className="space-y-2">
            {jobDetail.artifacts.map((artifact) => (
              <ArtifactItem
                key={artifact.name}
                artifact={artifact}
                provider={provider}
                jobUrl={job.url}
              />
            ))}
          </ul>
        </section>
      ) : null}
      {detail?.stages ? (
        <RelatedJobs detail={detail} current={job} />
      ) : detail !== null ? (
        <p className="text-muted-foreground">You can't view this pipeline's jobs.</p>
      ) : detailError !== null ? (
        <p className="text-muted-foreground">{detailError}</p>
      ) : null}
    </div>
  );
}
