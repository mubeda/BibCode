import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  PipelinesActionResult,
  PipelinesChanged,
  PipelinesDetail,
  PipelinesJobDetail,
  PipelinesJobLog,
  PipelinesJobLogInput,
  PipelinesListInput,
  PipelinesListPage,
  PipelinesRunActionInput,
  PipelinesSnapshot,
  PipelinesSubscribeInput,
} from "./pipelines.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

const decodeListPage = Schema.decodeUnknownSync(PipelinesListPage);
const decodeDetail = Schema.decodeUnknownSync(PipelinesDetail);
const decodeJobDetail = Schema.decodeUnknownSync(PipelinesJobDetail);
const decodeLog = Schema.decodeUnknownSync(PipelinesJobLog);
const decodeListInput = Schema.decodeUnknownSync(PipelinesListInput);
const decodeJobLogInput = Schema.decodeUnknownSync(PipelinesJobLogInput);
const decodeSubscribeInput = Schema.decodeUnknownSync(PipelinesSubscribeInput);
const decodeSnapshot = Schema.decodeUnknownSync(PipelinesSnapshot);
const decodeChanged = Schema.decodeUnknownSync(PipelinesChanged);
const decodeRunActionInput = Schema.decodeUnknownSync(PipelinesRunActionInput);
const decodeActionResult = Schema.decodeUnknownSync(PipelinesActionResult);

const row = {
  id: 4821,
  label: "#4821",
  title: "Fix the flaky test",
  status: "failed",
  warnings: false,
  reason: null,
  terminal: true,
  ref: { kind: "branch", name: "main", number: null, url: null },
  sha: "abc1234",
  actor: { login: "ana", name: "Ana Rossi", isBot: false },
  badges: ["latest", "branch"],
  createdAt: "2026-10-24T10:00:00Z",
  startedAt: null,
  finishedAt: null,
  durationSeconds: 252,
  queuedSeconds: null,
  stages: [{ name: "test", status: "failed", warnings: false }],
  attempt: null,
  permissions: { retry: "granted", cancel: "denied" },
  url: "https://gitlab.example/team/repo/-/pipelines/4821",
};

const job = {
  id: 998,
  name: "rspec 1/3",
  stage: "test",
  kind: "build",
  status: "failed",
  warnings: true,
  reason: null,
  terminal: true,
  startedAt: null,
  finishedAt: null,
  durationSeconds: null,
  queuedSeconds: null,
  permissions: { retry: "granted", cancel: "denied", play: "denied" },
  url: null,
  downstreamUrl: null,
};

describe("Pipelines contracts", () => {
  it("decodes a list page with and without the GitHub workflows field", () => {
    const decode = decodeListPage;
    const page = { revision: 7, rows: [row], nextCursor: "abc", total: null };
    expect(decode(page).workflows).toBeUndefined();
    expect(decode({ ...page, workflows: [{ id: 1, name: "CI" }] }).workflows).toEqual([
      { id: 1, name: "CI" },
    ]);
    expect(() => decode({ ...page, rows: [{ ...row, id: 0 }] })).toThrow();
    expect(() => decode({ ...page, rows: [{ ...row, permissions: { retry: "yes" } }] })).toThrow();
  });

  it("decodes a detail whose stages are hidden and one with job groups", () => {
    const decode = decodeDetail;
    const detail = {
      revision: 9,
      pipeline: row,
      commit: { sha: "abc1234", title: null, url: null },
      totalJobs: 1,
      stages: null,
      truncated: false,
      usesNeeds: false,
      artifacts: [],
    };
    expect(decode(detail).stages).toBeNull();
    const grouped = decode({
      ...detail,
      stages: [
        {
          name: "test",
          status: "failed",
          warnings: false,
          groups: [{ name: "rspec", size: 3, status: "failed", jobs: [job] }],
        },
      ],
    });
    expect(grouped.stages?.[0]?.groups[0]?.jobs[0]?.id).toBe(998);
  });

  it("decodes a job detail and both log variants", () => {
    const jobDetail = decodeJobDetail({
      revision: 3,
      job,
      pipelineId: 4821,
      attempt: null,
      runner: { name: "runner-1", description: null },
      tags: ["docker"],
      source: "push",
      createdAt: "2026-10-24T10:00:00Z",
      artifacts: [{ name: "trace", sizeBytes: 12, expiresAt: null, expired: false, url: null }],
      steps: [],
      logBytes: 12,
      erased: false,
      rawLogUrl: null,
    });
    expect(jobDetail.runner?.name).toBe("runner-1");
    expect(
      decodeLog({
        _tag: "chunk",
        text: "hello",
        offset: 0,
        nextOffset: 5,
        totalBytes: null,
        complete: false,
        truncatedHead: false,
        firstLine: 0,
      })._tag,
    ).toBe("chunk");
    expect(decodeLog({ _tag: "unavailable", reason: "not_started", url: null })._tag).toBe(
      "unavailable",
    );
    expect(() => decodeLog({ _tag: "unavailable", reason: "gone", url: null })).toThrow();
  });

  it("decodes inputs, the snapshot and the change names", () => {
    const list = decodeListInput({
      cwd: " /repo ",
      scope: "running",
      ref: null,
      workflowId: null,
      cursor: null,
      refresh: "timer",
    });
    expect(list.cwd).toBe("/repo");
    expect(
      decodeJobLogInput({
        cwd: "/repo",
        jobId: 998,
        attempt: null,
        from: { _tag: "before", offset: 512000 },
        refresh: "follow",
      }).from,
    ).toEqual({ _tag: "before", offset: 512000 });
    expect(
      decodeSubscribeInput({
        ...list,
        pipelineId: 4821,
        attempt: null,
        jobId: null,
      }).pipelineId,
    ).toBe(4821);
    expect(decodeSnapshot({ list: null, detail: null, job: null })).toEqual({
      list: null,
      detail: null,
      job: null,
    });
    expect(decodeChanged({ list: false, pipeline: true }).pipeline).toBe(true);
  });

  it("decodes an action on a pipeline or a job, and its result", () => {
    expect(
      decodeRunActionInput({
        cwd: "/repo",
        target: { _tag: "job", id: 998 },
        action: "play",
      }).target,
    ).toEqual({ _tag: "job", id: 998 });
    for (const action of ["retry", "retry_failed", "cancel"]) {
      expect(
        decodeRunActionInput({ cwd: "/repo", target: { _tag: "pipeline", id: 4821 }, action })
          .action,
      ).toBe(action);
    }
    expect(() =>
      decodeRunActionInput({ cwd: "/repo", target: { _tag: "stage", id: 1 }, action: "retry" }),
    ).toThrow();
    expect(() =>
      decodeRunActionInput({ cwd: "/repo", target: { _tag: "job", id: 0 }, action: "retry" }),
    ).toThrow();
    expect(() =>
      decodeRunActionInput({ cwd: "/repo", target: { _tag: "job", id: 9 }, action: "erase" }),
    ).toThrow();
    expect(decodeActionResult({ pipelineId: 4821, jobId: 1001 })).toEqual({
      pipelineId: 4821,
      jobId: 1001,
    });
    expect(decodeActionResult({ pipelineId: null, jobId: null }).jobId).toBeNull();
  });

  it("registers the six reads and the one action in the WebSocket group", () => {
    const methods = [
      WS_METHODS.pipelinesList,
      WS_METHODS.pipelinesGet,
      WS_METHODS.pipelinesGetJob,
      WS_METHODS.pipelinesGetJobLog,
      WS_METHODS.pipelinesReadSnapshot,
      WS_METHODS.pipelinesSubscribe,
      WS_METHODS.pipelinesRunAction,
    ];
    const registered = [...WsRpcGroup.requests.keys()].filter((tag) =>
      tag.startsWith("pipelines."),
    );
    expect(registered.toSorted()).toEqual(methods.toSorted());
  });
});
