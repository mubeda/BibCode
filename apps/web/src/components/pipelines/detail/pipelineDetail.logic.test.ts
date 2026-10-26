import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_PIPELINES_FILTERS } from "../../../pipelinesStore";
import { buildPipelinesListInput } from "../list/pipelinesList.logic";
import { pipelineDetail, pipelineJob } from "../testFixtures";
import {
  buildPipelineGetInput,
  detailSnapshotInput,
  detailTimerIntervalMs,
  pipelineAttemptOptions,
  pipelineFingerprint,
  pipelineHostUrl,
  pipelineJobAction,
  pipelineJobCount,
  pipelineStageColumns,
} from "./pipelineDetail.logic";

const SERVER_TOO_OLD = "Update the server to retry and cancel pipelines.";

describe("buildPipelineGetInput", () => {
  it("is the input a hovered row prefetched, so the open reuses that read", () => {
    expect(buildPipelineGetInput("/repo", 4821, null)).toEqual({
      cwd: "/repo",
      pipelineId: 4821,
      attempt: null,
      refresh: "user",
    });
  });
});

describe("detailSnapshotInput", () => {
  it("joins the list key the project's list shows, with the pipeline", () => {
    const list = buildPipelinesListInput({ ...DEFAULT_PIPELINES_FILTERS, ref: "main" }, "/repo");
    expect(detailSnapshotInput(list, 4821, 2)).toEqual({
      ...list,
      cursor: null,
      refresh: "user",
      pipelineId: 4821,
      attempt: 2,
      jobId: null,
    });
  });
});

describe("pipelineStageColumns", () => {
  it("keeps GitLab's stages in the host's order", () => {
    const detail = pipelineDetail();
    expect(pipelineStageColumns(detail, "gitlab")?.map((stage) => stage.name)).toEqual([
      "build",
      "test",
    ]);
  });

  it("puts every GitHub job in one Jobs column, in the host's order", () => {
    const detail = pipelineDetail({ pipeline: { status: "running", warnings: false } });
    const columns = pipelineStageColumns(detail, "github");
    expect(columns).toHaveLength(1);
    expect(columns?.[0]?.name).toBe("Jobs");
    expect(columns?.[0]?.status).toBe("running");
    expect(columns?.[0]?.groups.map((group) => group.name)).toEqual(["compile", "rspec"]);
  });

  it("has no columns when the account cannot read the jobs", () => {
    expect(pipelineStageColumns(pipelineDetail({ stages: null }), "gitlab")).toBeNull();
    expect(pipelineStageColumns(pipelineDetail({ stages: null }), "github")).toBeNull();
  });
});

describe("pipelineJobAction", () => {
  it("offers Run for a manual job, Cancel for an active one and Retry for a finished one", () => {
    expect(
      pipelineJobAction(
        {
          ...pipelineJob,
          status: "manual",
          terminal: false,
          permissions: { retry: "denied", cancel: "denied", play: "granted" },
        },
        null,
      ),
    ).toEqual({ kind: "play", label: "Run rspec", permission: { allowed: true, reason: null } });
    expect(
      pipelineJobAction(
        {
          ...pipelineJob,
          status: "running",
          terminal: false,
          permissions: { retry: "denied", cancel: "granted", play: "denied" },
        },
        null,
      )?.kind,
    ).toBe("cancel");
    expect(pipelineJobAction(pipelineJob, null)?.kind).toBe("retry");
  });

  it("offers nothing the host refused, since GitLab's answer also covers jobs it cannot retry", () => {
    expect(
      pipelineJobAction(
        { ...pipelineJob, permissions: { retry: "denied", cancel: "denied", play: "denied" } },
        null,
      ),
    ).toBeNull();
  });

  it("disables an action with the server's reason until it offers pipeline actions", () => {
    expect(pipelineJobAction(pipelineJob, SERVER_TOO_OLD)?.permission).toEqual({
      allowed: false,
      reason: SERVER_TOO_OLD,
    });
  });
});

describe("pipelineJobCount", () => {
  it("prefers the host's total, then counts the jobs shown", () => {
    expect(pipelineJobCount(pipelineDetail({ totalJobs: 1_240 }))).toBe(1_240);
    expect(pipelineJobCount(pipelineDetail({ totalJobs: null }))).toBe(2);
    expect(pipelineJobCount(pipelineDetail({ totalJobs: null, stages: null }))).toBeNull();
  });
});

describe("detailTimerIntervalMs", () => {
  it("reads GitLab every 10 s and doubles after 30 quiet minutes", () => {
    expect(detailTimerIntervalMs("gitlab", pipelineDetail({ totalJobs: 900 }), false)).toBe(10_000);
    expect(detailTimerIntervalMs("gitlab", pipelineDetail(), true)).toBe(20_000);
  });

  it("stretches GitHub by its job pages, up to ten", () => {
    expect(detailTimerIntervalMs("github", pipelineDetail({ totalJobs: 100 }), false)).toBe(10_000);
    expect(detailTimerIntervalMs("github", pipelineDetail({ totalJobs: 240 }), false)).toBe(30_000);
    expect(detailTimerIntervalMs("github", pipelineDetail({ totalJobs: 5_000 }), false)).toBe(
      100_000,
    );
    expect(detailTimerIntervalMs("github", pipelineDetail({ totalJobs: 240 }), true)).toBe(60_000);
  });
});

describe("pipelineFingerprint", () => {
  it("changes with the pipeline's status or a job's status, not with a new revision", () => {
    const detail = pipelineDetail();
    expect(pipelineFingerprint(pipelineDetail({ revision: 9 }))).toBe(pipelineFingerprint(detail));
    expect(pipelineFingerprint(pipelineDetail({ pipeline: { status: "running" } }))).not.toBe(
      pipelineFingerprint(detail),
    );
    const stages = detail.stages!.map((stage) => ({
      ...stage,
      groups: stage.groups.map((group) => ({
        ...group,
        jobs: group.jobs.map((job) => ({ ...job, status: "running" as const })),
      })),
    }));
    expect(pipelineFingerprint({ ...detail, stages })).not.toBe(pipelineFingerprint(detail));
  });
});

describe("pipelineHostUrl", () => {
  it("builds the host's pipeline page from the repository's web address", () => {
    expect(
      pipelineHostUrl({ provider: "gitlab", webUrl: "https://gitlab.com/acme/repo/" }, 7),
    ).toBe("https://gitlab.com/acme/repo/-/pipelines/7");
    expect(pipelineHostUrl({ provider: "github", webUrl: "https://github.com/o/r" }, 7)).toBe(
      "https://github.com/o/r/actions/runs/7",
    );
  });
});

describe("pipelineAttemptOptions", () => {
  it("offers nothing for a run GitHub has not re-run", () => {
    expect(pipelineAttemptOptions(null, 1)).toBeNull();
    expect(pipelineAttemptOptions(null, null)).toBeNull();
  });

  it("lists the latest attempt first, then each earlier one, on the latest page", () => {
    expect(pipelineAttemptOptions(null, 3)).toEqual({
      value: "latest",
      items: [
        { value: "latest", label: "Attempt 3 (latest)" },
        { value: "2", label: "Attempt 2" },
        { value: "1", label: "Attempt 1" },
      ],
    });
  });

  it("selects an earlier attempt, and keeps a way back when the latest is not known", () => {
    expect(pipelineAttemptOptions(1, 3)?.value).toBe("1");
    expect(pipelineAttemptOptions(2, null)).toEqual({
      value: "2",
      items: [
        { value: "latest", label: "Latest attempt" },
        { value: "2", label: "Attempt 2" },
        { value: "1", label: "Attempt 1" },
      ],
    });
  });
});
