import { describe, expect, it } from "vite-plus/test";
import {
  githubRefused,
  pipelineActionDestination,
  pipelineActionError,
  pipelineActionKey,
  shownPipelineStatus,
} from "./pipelineActions.logic";

const onLatest = { pipelineId: 4821, attempt: null, jobId: null };

describe("pipelineActionDestination", () => {
  it("opens a retried GitLab job's new job, and stays for every other GitLab action", () => {
    expect(
      pipelineActionDestination({
        provider: "gitlab",
        request: { target: { _tag: "job", id: 998 }, action: "retry" },
        result: { pipelineId: 4821, jobId: 1001 },
        shown: { pipelineId: 4821, attempt: null, jobId: 998 },
      }),
    ).toEqual({ kind: "job", pipelineId: 4821, jobId: 1001 });
    for (const [target, action] of [
      [{ _tag: "job", id: 998 }, "play"],
      [{ _tag: "job", id: 998 }, "cancel"],
      [{ _tag: "pipeline", id: 4821 }, "retry"],
    ] as const)
      expect(
        pipelineActionDestination({
          provider: "gitlab",
          request: { target, action },
          result: { pipelineId: 4821, jobId: target._tag === "job" ? 998 : null },
          shown: onLatest,
        }),
      ).toBeNull();
  });

  it("opens a GitHub run's latest attempt after a re-run from an earlier attempt or a job", () => {
    const rerun = { target: { _tag: "pipeline", id: 4821 }, action: "retry_failed" } as const;
    const result = { pipelineId: 4821, jobId: null };
    expect(
      pipelineActionDestination({ provider: "github", request: rerun, result, shown: onLatest }),
    ).toBeNull();
    expect(
      pipelineActionDestination({
        provider: "github",
        request: rerun,
        result,
        shown: { pipelineId: 4821, attempt: 1, jobId: null },
      }),
    ).toEqual({ kind: "pipeline", pipelineId: 4821 });
    expect(
      pipelineActionDestination({
        provider: "github",
        request: { target: { _tag: "job", id: 502 }, action: "retry" },
        result: { pipelineId: null, jobId: null },
        shown: { pipelineId: 4821, attempt: null, jobId: 502 },
      }),
    ).toEqual({ kind: "pipeline", pipelineId: 4821 });
    expect(
      pipelineActionDestination({
        provider: "github",
        request: { target: { _tag: "pipeline", id: 4821 }, action: "cancel" },
        result,
        shown: { pipelineId: 4821, attempt: 1, jobId: null },
      }),
    ).toBeNull();
  });
});

describe("pipeline action copy and state", () => {
  it("keys an action by its target and kind", () => {
    expect(pipelineActionKey({ target: { _tag: "job", id: 7 }, action: "play" })).toBe(
      "job:7:play",
    );
    expect(pipelineActionKey({ target: { _tag: "pipeline", id: 7 }, action: "play" })).not.toBe(
      "job:7:play",
    );
  });

  it("shows the server's copy, or a recovery when it gave none", () => {
    expect(pipelineActionError({ message: "This workflow run already finished." })).toBe(
      "This workflow run already finished.",
    );
    expect(pipelineActionError(new Error(" "))).toBe("The action failed. Refresh and try again.");
  });

  it("shows a GitHub cancel as canceling until the run's own status moves on", () => {
    const canceling = new Map([[4821, "running" as const]]);
    const row = { id: 4821, status: "running" as const, terminal: false };
    expect(shownPipelineStatus(row, canceling)).toBe("canceling");
    expect(shownPipelineStatus({ ...row, status: "queued" }, canceling)).toBe("queued");
    expect(shownPipelineStatus({ ...row, status: "canceled", terminal: true }, canceling)).toBe(
      "canceled",
    );
    expect(shownPipelineStatus({ ...row, id: 1 }, canceling)).toBe("running");
  });

  it("reads a GitHub denial as GitHub's refusal only when the role could act", () => {
    expect(["admin", "maintain", "write"].every((role) => githubRefused(role as never))).toBe(true);
    expect(["triage", "read", "none", null].some((role) => githubRefused(role as never))).toBe(
      false,
    );
  });
});
