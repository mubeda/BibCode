import type {
  PipelinesDetail,
  PipelinesJob,
  PipelinesListPage,
  PipelinesRow,
} from "@bibcode/contracts";

export const pipelineRow: PipelinesRow = {
  id: 4821,
  label: "#4821",
  title: "Fix connection recovery",
  status: "failed",
  warnings: false,
  reason: null,
  terminal: true,
  ref: { kind: "branch", name: "main", number: null, url: null },
  sha: "abc1234def5678",
  actor: { login: "ana", name: "Ana Rossi", isBot: false },
  badges: ["latest", "branch"],
  createdAt: "2026-10-25T10:00:00Z",
  startedAt: "2026-10-25T10:00:05Z",
  finishedAt: "2026-10-25T10:04:17Z",
  durationSeconds: 252,
  queuedSeconds: 5,
  stages: [
    { name: "build", status: "success", warnings: false },
    { name: "test", status: "failed", warnings: false },
  ],
  attempt: null,
  permissions: { retry: "granted", cancel: "granted" },
  url: "https://gitlab.com/acme/repo/-/pipelines/4821",
};

export function pipelinesPage(
  rows: readonly PipelinesRow[],
  options: { revision?: number; nextCursor?: string | null } = {},
): PipelinesListPage {
  return {
    revision: options.revision ?? 1,
    rows,
    nextCursor: options.nextCursor ?? null,
    total: { count: rows.length, capped: false },
  };
}

export const pipelineJob: PipelinesJob = {
  id: 998,
  name: "rspec",
  stage: "test",
  kind: "build",
  status: "failed",
  warnings: false,
  reason: null,
  terminal: true,
  startedAt: "2026-10-25T10:01:00Z",
  finishedAt: "2026-10-25T10:03:00Z",
  durationSeconds: 120,
  queuedSeconds: 2,
  permissions: { retry: "granted", cancel: "denied", play: "denied" },
  url: "https://gitlab.com/acme/repo/-/jobs/998",
  downstreamUrl: null,
};

/** A finished GitLab pipeline with a passed build stage and a failed test stage. */
export function pipelineDetail(
  options: { revision?: number; pipeline?: Partial<PipelinesRow> } & Partial<
    Omit<PipelinesDetail, "revision" | "pipeline">
  > = {},
): PipelinesDetail {
  const { revision, pipeline, ...rest } = options;
  return {
    revision: revision ?? 1,
    pipeline: { ...pipelineRow, ...pipeline },
    commit: {
      sha: "abc1234def5678",
      title: "Fix connection recovery",
      url: "https://gitlab.com/acme/repo/-/commit/abc1234def5678",
    },
    totalJobs: 2,
    stages: [
      {
        name: "build",
        status: "success",
        warnings: false,
        groups: [
          {
            name: "compile",
            size: 1,
            status: "success",
            jobs: [
              {
                ...pipelineJob,
                id: 997,
                name: "compile",
                stage: "build",
                status: "success",
                url: "https://gitlab.com/acme/repo/-/jobs/997",
              },
            ],
          },
        ],
      },
      {
        name: "test",
        status: "failed",
        warnings: false,
        groups: [{ name: "rspec", size: 1, status: "failed", jobs: [pipelineJob] }],
      },
    ],
    truncated: false,
    usesNeeds: false,
    artifacts: [],
    ...rest,
  };
}
