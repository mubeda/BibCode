import type { PipelinesDetail, PipelinesJob, PipelinesJobDetail } from "@bibcode/contracts";
import { pipelineRow } from "../testFixtures";

export function pipelineJob(overrides: Partial<PipelinesJob> = {}): PipelinesJob {
  return {
    id: 998,
    name: "rspec",
    stage: "test",
    kind: "build",
    status: "failed",
    warnings: false,
    reason: null,
    terminal: true,
    startedAt: "2026-10-25T10:01:00Z",
    finishedAt: "2026-10-25T10:04:00Z",
    durationSeconds: 180,
    queuedSeconds: 4,
    permissions: { retry: "granted", cancel: "granted", play: "denied" },
    url: "https://gitlab.com/acme/repo/-/jobs/998",
    downstreamUrl: null,
    ...overrides,
  };
}

export function pipelineDetail(
  jobs: readonly PipelinesJob[] = [pipelineJob()],
  overrides: Partial<PipelinesDetail> = {},
): PipelinesDetail {
  const stages = [...new Set(jobs.map((job) => job.stage))];
  return {
    revision: 10,
    pipeline: pipelineRow,
    commit: {
      sha: pipelineRow.sha,
      title: "Fix connection recovery",
      url: "https://gitlab.com/acme/repo/-/commit/abc1234def5678",
    },
    totalJobs: jobs.length,
    stages: stages.map((stage) => ({
      name: stage,
      status: "failed",
      warnings: false,
      groups: jobs
        .filter((job) => job.stage === stage)
        .map((job) => ({ name: job.name, size: 1, status: job.status, jobs: [job] })),
    })),
    truncated: false,
    usesNeeds: false,
    artifacts: [],
    ...overrides,
  };
}

export function pipelineJobDetail(overrides: Partial<PipelinesJobDetail> = {}): PipelinesJobDetail {
  return {
    revision: 10,
    job: pipelineJob(),
    pipelineId: pipelineRow.id,
    attempt: null,
    runner: { name: "gitlab-runner-3", description: "shared-runner-3" },
    tags: ["docker", "linux"],
    source: "push",
    createdAt: "2026-10-25T10:00:56Z",
    artifacts: [
      {
        name: "coverage.zip",
        sizeBytes: 12_400_000,
        expiresAt: "2026-11-25T10:04:00Z",
        expired: false,
        url: "https://gitlab.com/acme/repo/-/jobs/998",
      },
    ],
    steps: [],
    logBytes: 5_321,
    erased: false,
    rawLogUrl: "https://gitlab.com/acme/repo/-/jobs/998/raw",
    ...overrides,
  };
}
