import { PullRequestsOperationError, type PipelinesLogUnavailableReason } from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";
import { jobLogStatusCopy, lineAtTime, logScrolledToEnd } from "./jobLog.logic";
import { INITIAL_JOB_LOG_READER_STATE, type JobLogReaderState } from "./jobLogReader";
import type { JobLogSource } from "./useJobLogController";

const live: JobLogSource = { _tag: "live", jobId: 1, attempt: null, started: true };
const queued: JobLogSource = { _tag: "live", jobId: 1, attempt: null, started: false };
const finished: JobLogSource = { _tag: "complete", jobId: 1, attempt: null };

function unavailable(reason: PipelinesLogUnavailableReason): JobLogReaderState {
  return {
    ...INITIAL_JOB_LOG_READER_STATE,
    phase: "unavailable",
    unavailable: { reason, url: null },
  };
}

function failed(code: string): JobLogReaderState {
  return {
    ...INITIAL_JOB_LOG_READER_STATE,
    phase: "failed",
    error: new PullRequestsOperationError({
      operation: "pipelines.getJobLog",
      code,
      message: "GitLab didn't answer in time.",
      hostDetail: null,
      retryable: code === "timeout",
    }),
    errorMessage: "GitLab didn't answer in time.",
  };
}

describe("job log copy", () => {
  it("says why each log is unavailable", () => {
    const copy = (reason: PipelinesLogUnavailableReason, source: JobLogSource = finished) =>
      jobLogStatusCopy({ source, reader: unavailable(reason), hostName: "GitLab" })?.message;
    expect(copy("not_started", queued)).toBe("This job hasn't started yet.");
    expect(copy("not_started", live)).toBe("Waiting for the job's first output.");
    expect(copy("no_output")).toBe("This job didn't produce a log.");
    expect(copy("erased")).toBe("This job's log was erased.");
    expect(copy("expired")).toBe("This log has expired.");
    expect(copy("live_on_host")).toBe("GitLab shows live logs on its site.");
    expect(copy("too_large_live", live)).toBe(
      "This running log is over 2 MB. BiBCode shows it once the job finishes; GitLab shows the live end.",
    );
    expect(
      jobLogStatusCopy({
        source: { _tag: "unavailable", reason: "erased", url: null },
        reader: INITIAL_JOB_LOG_READER_STATE,
        hostName: "GitLab",
      })?.message,
    ).toBe("This job's log was erased.");
  });

  it("offers the host's page where it shows what BiBCode cannot", () => {
    const link = (reason: PipelinesLogUnavailableReason) =>
      jobLogStatusCopy({ source: live, reader: unavailable(reason), hostName: "GitLab" })?.link;
    expect(link("too_large_live")).toBe(true);
    expect(link("live_on_host")).toBe(true);
    expect(link("no_output")).toBe(false);
  });

  it("keeps a refused log on the page without the sign-in state, and lets other failures retry", () => {
    expect(
      jobLogStatusCopy({ source: live, reader: failed("forbidden"), hostName: "GitLab" }),
    ).toEqual({
      message: "You can't view this job's log.",
      tone: "error",
      retry: false,
      link: true,
    });
    expect(
      jobLogStatusCopy({ source: live, reader: failed("not_found"), hostName: "GitLab" })?.message,
    ).toBe("This job no longer exists.");
    expect(
      jobLogStatusCopy({ source: live, reader: failed("timeout"), hostName: "GitLab" }),
    ).toMatchObject({
      message: "GitLab didn't answer in time.",
      retry: true,
    });
    expect(
      jobLogStatusCopy({ source: live, reader: INITIAL_JOB_LOG_READER_STATE, hostName: "GitLab" }),
    ).toBeNull();
  });

  it("treats the last 24 px of the log as its end", () => {
    const at = (y: number) =>
      logScrolledToEnd({
        contentOffset: { y },
        contentSize: { height: 1_000 },
        layoutMeasurement: { height: 400 },
      });
    expect(at(600)).toBe(true);
    expect(at(580)).toBe(true);
    expect(at(560)).toBe(false);
  });
});

describe("lineAtTime", () => {
  it("finds the first stamped line at or after a time, skipping unstamped lines", () => {
    const stamps = Float64Array.from([Number.NaN, 1_000, 1_000, 2_000, Number.NaN, 3_000]);
    expect(lineAtTime(stamps, 0)).toBe(1);
    expect(lineAtTime(stamps, 1_500)).toBe(3);
    expect(lineAtTime(stamps, 2_500)).toBe(5);
    expect(lineAtTime(stamps, 3_001)).toBe(-1);
    expect(lineAtTime(new Float64Array(0), 0)).toBe(-1);
  });
});
