import { describe, expect, it } from "vite-plus/test";
import {
  elapsedSeconds,
  findPipelineJob,
  formatBytes,
  gitlabArtifactLinks,
  jobSnapshotInput,
  pipelineJobActions,
  relatedStages,
  shownJob,
  stepDurationSeconds,
} from "./pipelineJob.logic";
import {
  parsePipelineRouteId,
  pipelineJobLink,
  validatePipelineJobSearch,
} from "./pipelineJobRoute";
import { pipelineDetail, pipelineJob, pipelineJobDetail } from "./testFixtures";

const SERVER_TOO_OLD = "Update the server to retry and cancel pipelines.";

describe("job route", () => {
  it("accepts only positive integer ids that fit a Number", () => {
    expect(parsePipelineRouteId("998")).toBe(998);
    expect(parsePipelineRouteId("0")).toBeNull();
    expect(parsePipelineRouteId("abc")).toBeNull();
    expect(parsePipelineRouteId("1.5")).toBeNull();
    expect(parsePipelineRouteId("99999999999999999999")).toBeNull();
  });

  it("keeps a valid line offset and drops anything else", () => {
    expect(validatePipelineJobSearch({ at: "1204" })).toEqual({ at: 1204 });
    expect(validatePipelineJobSearch({ at: 0 })).toEqual({ at: 0 });
    expect(validatePipelineJobSearch({ at: "-3" })).toEqual({});
    expect(validatePipelineJobSearch({ at: "x" })).toEqual({});
  });

  it("builds a job link with its line offset", () => {
    expect(
      pipelineJobLink({
        environmentId: "env",
        projectId: "p",
        pipelineId: 4821,
        jobId: 998,
        at: 64,
      }),
    ).toEqual({
      to: "/project/$environmentId/$projectId/pipelines/$pipelineId/jobs/$jobId",
      params: { environmentId: "env", projectId: "p", pipelineId: "4821", jobId: "998" },
      search: { at: 64 },
    });
    expect(
      pipelineJobLink({ environmentId: "env", projectId: "p", pipelineId: 1, jobId: 2 }).search,
    ).toEqual({});
  });
});

describe("job page logic", () => {
  it("subscribes with the remembered list key, the pipeline and the job", () => {
    expect(
      jobSnapshotInput({ scope: "running", ref: "main", workflowId: null }, "/repo", 4821, 998),
    ).toEqual({
      cwd: "/repo",
      scope: "running",
      ref: "main",
      workflowId: null,
      cursor: null,
      refresh: "user",
      pipelineId: 4821,
      attempt: null,
      jobId: 998,
    });
  });

  it("takes the job's status from its pipeline's detail, else from the job read", () => {
    const running = pipelineJob({ status: "running", terminal: false });
    const detail = pipelineDetail([running, pipelineJob({ id: 999, name: "lint" })]);
    const jobDetail = pipelineJobDetail();
    expect(findPipelineJob(detail, 998)).toEqual({ job: running, stage: "test" });
    expect(shownJob(detail, jobDetail, 998)).toBe(running);
    expect(shownJob(null, jobDetail, 998)).toBe(jobDetail.job);
    expect(shownJob(pipelineDetail([]), null, 998)).toBeNull();
  });

  it("takes a newer job read's status, keeping the pipeline's permissions", () => {
    const running = pipelineJob({ status: "running", terminal: false });
    const detail = pipelineDetail([running], { revision: 10 });
    const finished = pipelineJob({
      permissions: { retry: "unknown", cancel: "unknown", play: "unknown" },
    });
    const newer = pipelineJobDetail({ revision: 11, job: finished });
    expect(shownJob(detail, newer, 998)).toEqual({
      ...finished,
      permissions: running.permissions,
    });
    expect(shownJob(detail, pipelineJobDetail({ revision: 10, job: finished }), 998)).toBe(running);
  });

  it("lists every stage's jobs for the related jobs panel", () => {
    const detail = pipelineDetail([
      pipelineJob({ id: 1, stage: "build", name: "compile" }),
      pipelineJob({ id: 2, stage: "test", name: "rspec 1/2" }),
      pipelineJob({ id: 3, stage: "test", name: "rspec 2/2" }),
    ]);
    expect(relatedStages(detail).map((stage) => [stage.name, stage.jobs.map((j) => j.id)])).toEqual(
      [
        ["build", [1]],
        ["test", [2, 3]],
      ],
    );
    expect(relatedStages({ ...detail, stages: null })).toEqual([]);
  });

  it("offers Retry for a failed job, Cancel for a running one and Play for a manual one", () => {
    expect(pipelineJobActions(pipelineJob(), null)).toEqual({
      retry: { allowed: true, reason: null },
      cancel: null,
      play: null,
    });
    expect(pipelineJobActions(pipelineJob({ status: "success" }), null).retry).toBeNull();
    expect(
      pipelineJobActions(pipelineJob({ status: "running", terminal: false }), SERVER_TOO_OLD),
    ).toEqual({ retry: null, cancel: { allowed: false, reason: SERVER_TOO_OLD }, play: null });
    expect(pipelineJobActions(pipelineJob({ status: "manual", terminal: true }), null)).toEqual({
      retry: null,
      cancel: null,
      play: { allowed: false, reason: "You don't have permission to run this job." },
    });
    // The host's refusal wins over an older server's reason.
    expect(
      pipelineJobActions(
        pipelineJob({ permissions: { retry: "denied", cancel: "granted", play: "granted" } }),
        SERVER_TOO_OLD,
      ).retry,
    ).toEqual({ allowed: false, reason: "You don't have permission to retry this job." });
  });

  it("offers a GitHub job Retry alone, and names GitHub's refusal of it", () => {
    const running = pipelineJob({
      status: "running",
      terminal: false,
      permissions: { retry: "unknown", cancel: "denied", play: "denied" },
    });
    expect(pipelineJobActions(running, null, "github", "write")).toEqual({
      retry: null,
      cancel: null,
      play: null,
    });
    const refused = pipelineJob({
      permissions: { retry: "denied", cancel: "denied", play: "denied" },
    });
    expect(pipelineJobActions(refused, null, "github", "admin").retry?.reason).toBe(
      "GitHub refused: this sign-in can't run Actions for this repository. A fine-grained token needs Actions write.",
    );
    expect(pipelineJobActions(refused, null, "github", "read").retry?.reason).toBe(
      "You need write access to this repository to re-run jobs.",
    );
  });

  it("builds GitLab's artifact pages on the job's web URL", () => {
    expect(gitlabArtifactLinks("https://gitlab.com/acme/repo/-/jobs/998/")).toEqual({
      download: "https://gitlab.com/acme/repo/-/jobs/998/artifacts/download",
      browse: "https://gitlab.com/acme/repo/-/jobs/998/artifacts/browse",
    });
    expect(gitlabArtifactLinks(null)).toBeNull();
  });

  it("formats sizes and elapsed time", () => {
    expect(formatBytes(96)).toBe("96 B");
    expect(formatBytes(812_000)).toBe("812 KB");
    expect(formatBytes(12_400_000)).toBe("12.4 MB");
    expect(elapsedSeconds("2026-10-25T10:00:00Z", Date.parse("2026-10-25T10:01:30Z"))).toBe(90);
    expect(elapsedSeconds(null, 0)).toBeNull();
  });

  it("times a finished step, and not one still running", () => {
    const step = {
      number: 2,
      name: "Run tests",
      status: "success" as const,
      startedAt: "2026-10-25T10:01:07Z",
      completedAt: "2026-10-25T10:02:33Z",
    };
    expect(stepDurationSeconds(step)).toBe(86);
    expect(stepDurationSeconds({ ...step, completedAt: null })).toBeNull();
    expect(stepDurationSeconds({ ...step, startedAt: "not a time" })).toBeNull();
  });
});
