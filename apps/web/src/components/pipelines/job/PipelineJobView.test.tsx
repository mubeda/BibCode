// @vitest-environment happy-dom
import {
  EnvironmentId,
  type PipelinesChanged,
  type PipelinesDetail,
  type PipelinesJobDetail,
  type PipelinesJobLog,
  type PipelinesJobLogInput,
  type PipelinesSnapshot,
} from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, useReducer, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_PIPELINES_FILTERS } from "../../../pipelinesStore";
import { gitlabContext } from "../../pullRequests/detail/testFixtures";
import { context as githubContext } from "../../pullRequests/testFixtures";
import {
  RepositoryModule,
  type RepositoryModuleValue,
} from "../../repositoryModule/RepositoryModule";
import { utf8Length } from "../log/jobLog.parse";
import { pipelinesModule } from "../pipelinesModule";
import { pipelineDetail, pipelineJob, pipelineJobDetail } from "./testFixtures";

type Kind = "get" | "getJob" | "readSnapshot" | "subscribe";
const h = vi.hoisted(() => ({
  detail: null as PipelinesDetail | null,
  job: null as PipelinesJobDetail | null,
  snapshot: null as PipelinesSnapshot | null,
  nextSnapshot: null as PipelinesSnapshot | null,
  changed: null as PipelinesChanged | null,
  streamFailed: false,
  publish: [] as (() => void)[],
  reads: { get: 0, getJob: 0, readSnapshot: 0, subscribe: 0 } as Record<string, number>,
  timerReads: vi.fn(),
  logReads: [] as PipelinesJobLogInput[],
  logAnswers: [] as PipelinesJobLog[],
  logAnswer: null as ((input: PipelinesJobLogInput) => PipelinesJobLog | null) | null,
  navigate: vi.fn(),
  actions: [] as unknown[],
  pending: new Set<string>(),
  inflight: [] as (() => void)[],
}));
vi.mock("../../../state/pipelines", () => {
  const atom = (kind: string) => (args: { input: unknown }) => ({ kind, ...args });
  return {
    pipelinesEnvironment: {
      get: atom("get"),
      getJob: atom("getJob"),
      readSnapshot: atom("readSnapshot"),
      subscribe: atom("subscribe"),
      requestTimerRead: h.timerReads,
      getJobLog: { label: "environment-data:pipelines:get-job-log" },
      runAction: { label: "environment-data:pipelines:run-action" },
    },
  };
});
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: (atom: { kind: Kind } | null) => {
    const [, publish] = useReducer((value: number) => value + 1, 0);
    h.publish.push(publish);
    const kind = atom?.kind ?? null;
    const data =
      kind === "get"
        ? h.detail
        : kind === "getJob"
          ? h.job
          : kind === "readSnapshot"
            ? h.snapshot
            : kind === "subscribe"
              ? h.changed
              : null;
    const read = () => {
      if (kind === null) return;
      h.reads[kind] = (h.reads[kind] ?? 0) + 1;
      if (kind === "readSnapshot" && h.nextSnapshot) h.snapshot = h.nextSnapshot;
      if (kind === "get" || kind === "getJob") {
        // A read stays pending until `settle`, then answers with a new copy, as the
        // atom runtime does.
        h.pending.add(kind);
        h.inflight.push(() => {
          h.pending.delete(kind);
          if (kind === "get" && h.detail) h.detail = { ...h.detail };
          if (kind === "getJob" && h.job) h.job = { ...h.job };
          publish();
        });
      }
      publish();
    };
    const emission =
      kind === "subscribe" && h.streamFailed
        ? { _tag: "Failure", cause: Cause.fail(new Error("stream down")) }
        : data
          ? { _tag: "Success", value: data }
          : { _tag: "Initial" };
    return {
      data,
      emission,
      error: null,
      isPending: (kind === "get" || kind === "getJob") && (data === null || h.pending.has(kind)),
      refresh: read,
      revalidate: read,
      requiresRetry: false,
    };
  },
}));
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand:
    (command: { label: string }) => async (value: { input: PipelinesJobLogInput }) => {
      if (command.label === "environment-data:pipelines:run-action") {
        h.actions.push(value.input);
        return AsyncResult.success({ pipelineId: 4821, jobId: 1001 });
      }
      h.logReads.push(value.input);
      const next = h.logAnswer?.(value.input) ?? h.logAnswers.shift() ?? null;
      return next === null ? new Promise(() => {}) : AsyncResult.success(next);
    },
}));
vi.mock("../log/jobLogEngine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../log/jobLogEngine")>();
  return {
    ...actual,
    createJobLogEngine: () => actual.createMainThreadJobLogEngine(() => Promise.resolve()),
  };
});
vi.mock("../../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("../../../lib/openPullRequestLink", () => ({ useOpenPrLink: () => vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
  useNavigate: () => h.navigate,
}));
vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: {
    data: readonly number[];
    keyExtractor: (item: number) => string;
    renderItem: (p: { item: number; index: number }) => ReactNode;
  }) => (
    <div role="log">
      {props.data.map((item, index) => (
        <div key={props.keyExtractor(item)}>{props.renderItem({ item, index })}</div>
      ))}
    </div>
  ),
}));

import { PipelineJobView } from "./PipelineJobView";

const HOUR = 3_600_000;
const scope = { environmentId: EnvironmentId.make("env"), cwd: "/repo" };
const running = pipelineJob({ status: "running", terminal: false, finishedAt: null });
const runningRow = { ...pipelineDetail().pipeline, status: "running" as const, terminal: false };
let container: HTMLDivElement;
let root: Root;

function moduleValue(provider: "gitlab" | "github" = "gitlab"): RepositoryModuleValue {
  return {
    state: {
      availability: { kind: "ready" },
      project: null,
      cwd: scope.cwd,
      scope,
      context: provider === "github" ? githubContext : gitlabContext,
      contextQuery: {} as never,
      storedContext: false,
      worktreeOptions: [],
      worktreeStatus: null,
      freshPageKey: null,
    },
    actions: { rescan: vi.fn(), recover: vi.fn(), setCwd: vi.fn(), consumeFreshPage: vi.fn() },
    meta: {
      module: pipelinesModule,
      projectRef: { environmentId: "env", projectId: "p" } as never,
      mutationsDisabledReason: "Update the server to retry and cancel pipelines.",
    },
  };
}

function logChunk(text: string, offset: number, complete: boolean): PipelinesJobLog {
  return {
    _tag: "chunk",
    text,
    offset,
    nextOffset: offset + utf8Length(text),
    totalBytes: null,
    complete,
    truncatedHead: false,
    firstLine: offset === 0 ? 0 : null,
  };
}

function fullWindow(offset: number): PipelinesJobLog {
  const line = `${"x".repeat(99)}\n`;
  return logChunk(line.repeat(5_120), offset, false);
}

/** Flushes until `check` passes: spans and layouts arrive over several async turns. */
async function until(check: () => void, attempts = 50) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      check();
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      await flush();
    }
  }
}

async function flush() {
  await act(async () => {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  });
  if (h.inflight.length === 0) return;
  await act(async () => {
    for (const answer of h.inflight.splice(0)) answer();
  });
  await act(async () => {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  });
}

/** Advances fake time in 5 s steps, letting each follow read land before the next. */
async function advance(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 5_000) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await flush();
  }
}

/** Reads made by opening the page; the budget counts what follows them. */
let opened = { get: 0, getJob: 0 };
async function render(provider: "gitlab" | "github" = "gitlab") {
  const value = moduleValue(provider);
  await act(async () =>
    root.render(
      <RepositoryModule.Provider value={value}>
        <PipelineJobView
          filters={DEFAULT_PIPELINES_FILTERS}
          pipelineId={4821}
          jobId={998}
          at={null}
        />
      </RepositoryModule.Provider>,
    ),
  );
  await flush();
  await flush();
  opened = { get: h.reads.get ?? 0, getJob: h.reads.getJob ?? 0 };
}
const since = (kind: "get" | "getJob") => (h.reads[kind] ?? 0) - opened[kind];

async function rerenderAll() {
  await act(async () => {
    for (const publish of h.publish.splice(0)) publish();
  });
  await flush();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(Date.parse("2026-10-25T10:05:00Z"));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  h.detail = pipelineDetail([running], { pipeline: runningRow });
  h.job = pipelineJobDetail({ job: running });
  h.snapshot = null;
  h.nextSnapshot = null;
  h.changed = { list: false, pipeline: false };
  h.streamFailed = false;
  h.publish = [];
  h.reads = { get: 0, getJob: 0, readSnapshot: 0, subscribe: 0 };
  h.timerReads.mockClear();
  h.logReads = [];
  h.logAnswers = [];
  h.logAnswer = null;
  h.pending.clear();
  h.inflight = [];
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("PipelineJobView on GitHub", () => {
  const steps = [
    {
      number: 1,
      name: "Set up job",
      status: "success" as const,
      startedAt: "2026-10-25T10:01:00Z",
      completedAt: "2026-10-25T10:01:02Z",
    },
    {
      number: 2,
      name: "Run tests",
      status: "running" as const,
      startedAt: "2026-10-25T10:01:02Z",
      completedAt: null,
    },
  ];
  const githubJob = (overrides: Parameters<typeof pipelineJob>[0] = {}) =>
    pipelineJob({
      stage: "",
      url: "https://github.com/owner/repo/actions/runs/4821/job/998",
      ...overrides,
    });

  it("shows a running job's steps where the log will be, re-reading the job every 10 s and the run every 30 s", async () => {
    const job = githubJob({ status: "running", terminal: false, finishedAt: null });
    h.detail = pipelineDetail([job], { pipeline: runningRow });
    h.job = pipelineJobDetail({ job, attempt: 2, steps });
    await render("github");
    expect(container.textContent).toContain("GitHub shows live logs on its site.");
    const log = container.querySelector('[aria-label="Job details"]')!.nextElementSibling!;
    expect(log.textContent).toContain("Run tests");
    expect(h.logReads).toEqual([]);
    expect(h.reads.subscribe).toBe(0);
    await advance(HOUR);
    expect(h.logReads).toEqual([]);
    expect(since("getJob")).toBe(360);
    // A one-page run: the run and its jobs page every 30 s, 240 reads an hour.
    expect(since("get")).toBe(120);
  }, 90_000);

  it("says a queued job has not started, reading no log", async () => {
    const job = githubJob({ status: "queued", terminal: false, startedAt: null, finishedAt: null });
    h.detail = pipelineDetail([job], { pipeline: runningRow });
    h.job = pipelineJobDetail({ job, attempt: 1, steps: [] });
    await render("github");
    expect(container.textContent).toContain("This job hasn't started yet.");
    expect(container.textContent).not.toContain("shows live logs");
    expect(h.logReads).toEqual([]);
  });

  it("reads a finished job's log once, under the job's attempt, and lets its steps find themselves in it", async () => {
    const job = githubJob();
    // The run still runs other jobs; this finished one needs no more reads.
    h.detail = pipelineDetail([job], {
      pipeline: runningRow,
      artifacts: [
        {
          name: "coverage",
          sizeBytes: 20_480,
          expiresAt: "2027-01-22T10:00:00Z",
          expired: false,
          url: "https://github.com/owner/repo/actions/runs/4821",
        },
      ],
    });
    h.job = pipelineJobDetail({
      job,
      attempt: 2,
      artifacts: [],
      steps: steps.map((step) => ({
        ...step,
        status: "success" as const,
        completedAt: "2026-10-25T10:02:00Z",
      })),
    });
    h.logAnswers = [
      logChunk(
        "2026-10-25T10:01:00.0000000Z ##[group]Set up job\n2026-10-25T10:01:03.0000000Z npm test\n",
        0,
        true,
      ),
    ];
    await render("github");
    expect(h.logReads).toEqual([
      { cwd: "/repo", jobId: 998, attempt: 2, from: { _tag: "tail" }, refresh: "user" },
    ]);
    await until(() =>
      expect(
        container.querySelector('button[aria-label="Run tests: passed. Show in the log"]'),
      ).not.toBeNull(),
    );
    const details = container.querySelector('[aria-label="Job details"]')!;
    expect(details.textContent).toContain("coverage");
    await advance(HOUR);
    expect(h.logReads).toHaveLength(1);
    expect(since("get") + since("getJob")).toBe(0);
  });
});

describe("PipelineJobView", () => {
  it("follows a running GitLab job's log 720 times an hour with no timer job or pipeline reads", async () => {
    let end = 0;
    h.logAnswer = (input) => {
      const offset = input.from._tag === "offset" ? input.from.offset : 0;
      const text = `line at ${offset}\n`;
      end = offset + utf8Length(text);
      return logChunk(text, offset, false);
    };
    await render();
    expect(h.logReads).toEqual([
      { cwd: "/repo", jobId: 998, attempt: null, from: { _tag: "tail" }, refresh: "user" },
    ]);
    await advance(HOUR);
    const follows = h.logReads.slice(1);
    expect(follows).toHaveLength(720);
    expect(follows.every((read) => read.refresh === "follow" && read.from._tag === "offset")).toBe(
      true,
    );
    expect(end).toBeGreaterThan(0);
    // The stream is live: the pipeline row comes from the poller, so no timer reads.
    expect(h.timerReads).not.toHaveBeenCalled();
    expect(opened).toEqual({ get: 1, getJob: 1 });
    expect(since("get")).toBe(0);
    expect(since("getJob")).toBe(0);
    // An hour of 5 s steps renders 720 log reads; give it room on a busy runner.
  }, 90_000);

  it("stops following while the document is hidden and resumes when it is shown", async () => {
    h.logAnswer = (input) => {
      const offset = input.from._tag === "offset" ? input.from.offset : 0;
      return logChunk(`at ${offset}\n`, offset, false);
    };
    await render();
    const setVisibility = (state: DocumentVisibilityState) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    await act(async () => setVisibility("hidden"));
    await advance(HOUR);
    expect(h.logReads).toHaveLength(1);
    await act(async () => setVisibility("visible"));
    await advance(5_000);
    expect(h.logReads).toHaveLength(2);
  });

  it("reads the job once and the log once more when the job finishes, then nothing", async () => {
    h.logAnswer = (input) => (input.from._tag === "tail" ? logChunk("start\n", 0, false) : null);
    await render();
    const finished = pipelineJob();
    h.logAnswer = null;
    h.logAnswers = [logChunk("done\n", 6, true)];
    // The poller names the pipeline; its stored row shows the job finished.
    h.nextSnapshot = {
      list: null,
      detail: { payload: pipelineDetail([finished], { revision: 20 }), observedAt: 2 },
      job: null,
    };
    h.changed = { list: false, pipeline: true };
    await rerenderAll();
    await flush();
    expect(h.reads.readSnapshot).toBe(1);
    expect(since("getJob")).toBe(1);
    expect(h.logReads.at(-1)).toMatchObject({
      from: { _tag: "offset", offset: 6 },
      refresh: "user",
    });
    const reads = h.logReads.length;
    await advance(HOUR);
    expect(h.logReads).toHaveLength(reads);
    expect(since("getJob")).toBe(1);
    await until(() => expect(container.textContent).toContain("done"));
  });

  it("replaces the job with the poller's refusal of its pipeline, reading nothing more", async () => {
    h.logAnswer = (input) => (input.from._tag === "tail" ? logChunk("start\n", 0, false) : null);
    await render();
    expect(container.textContent).toContain(running.name);
    const reads = { ...h.reads };
    const logReads = h.logReads.length;
    // Access was revoked while the page was open: the poller dropped the stored row.
    h.nextSnapshot = { list: null, detail: null, job: null };
    h.changed = { list: false, pipeline: true, refused: "forbidden" };
    await rerenderAll();
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "You can't view this job.",
    );
    expect(container.querySelector("h1")).toBeNull();
    expect(container.textContent).not.toContain("Cancel");
    await advance(HOUR);
    expect(h.reads.get).toBe(reads.get);
    expect(h.reads.getJob).toBe(reads.getJob);
    expect(h.logReads).toHaveLength(logReads);
  });

  it("opens a running log with at most four reads and pauses a too-large one until it finishes", async () => {
    h.logAnswers = [
      fullWindow(0),
      fullWindow(512_000),
      fullWindow(1_024_000),
      {
        _tag: "unavailable",
        reason: "too_large_live",
        url: "https://gitlab.com/acme/repo/-/jobs/998",
      },
    ];
    await render();
    expect(h.logReads).toHaveLength(4);
    expect(container.textContent).toContain("This running log is over 2 MB.");
    await advance(HOUR);
    expect(h.logReads).toHaveLength(4);
  });

  it("reads a finished job's log once", async () => {
    h.detail = pipelineDetail([pipelineJob()]);
    h.job = pipelineJobDetail();
    h.logAnswers = [logChunk("all of it\n", 0, true)];
    await render();
    await advance(HOUR);
    expect(h.logReads).toHaveLength(1);
    expect(since("get") + since("getJob")).toBe(0);
  });

  it("re-reads a running pipeline on the 10 s timer while the stream is down", async () => {
    h.streamFailed = true;
    h.logAnswers = [logChunk("start\n", 0, false)];
    h.logAnswer = null;
    await render();
    await advance(60_000);
    expect(h.timerReads).toHaveBeenCalledWith({
      environmentId: "env",
      input: { cwd: "/repo", pipelineId: 4821, attempt: null, refresh: "user" },
    });
    expect(since("get")).toBe(6);
  });

  it("paints the stored job before the job read answers", async () => {
    h.detail = null;
    h.job = null;
    h.snapshot = {
      list: null,
      detail: null,
      job: {
        payload: pipelineJobDetail({ job: pipelineJob({ name: "stored-rspec" }) }),
        observedAt: 1,
      },
    };
    h.logAnswers = [logChunk("stored\n", 0, true)];
    await render();
    expect(container.querySelector("h1")?.textContent).toContain("stored-rspec");
    expect(container.textContent).toContain("Job #998 · stage test");
    // A disabled action says why.
    const retry = [...container.querySelectorAll("button")].find((b) => b.textContent === "Retry");
    expect(retry?.disabled).toBe(true);
    expect(retry?.getAttribute("title")).toBe("Update the server to retry and cancel pipelines.");
  });

  it("shows the runner, tags, artifacts and the stage's other jobs", async () => {
    h.detail = pipelineDetail([
      pipelineJob(),
      pipelineJob({ id: 999, name: "rubocop", status: "success" }),
    ]);
    h.job = pipelineJobDetail();
    h.logAnswers = [logChunk("x\n", 0, true)];
    await render();
    const details = container.querySelector('[aria-label="Job details"]')!;
    expect(details.textContent).toContain("gitlab-runner-3");
    expect(details.textContent).toContain("docker");
    expect(details.textContent).toContain("coverage.zip");
    expect(details.querySelector('a[href$="/jobs/998/artifacts/browse"]')).not.toBeNull();
    expect(
      [...details.querySelectorAll("a")].map((link) => link.textContent).filter(Boolean),
    ).toEqual(expect.arrayContaining(["rspec3m 0s", "rubocop3m 0s"]));
    expect(details.textContent).not.toContain("Timeout");
  });
});

/** A server that serves `pipelines.runAction`. */
function readyModuleValue(provider: "gitlab" | "github"): RepositoryModuleValue {
  const base = moduleValue(provider);
  return { ...base, meta: { ...base.meta, mutationsDisabledReason: null } };
}

describe("PipelineJobView actions", () => {
  async function renderReady(provider: "gitlab" | "github") {
    const value = readyModuleValue(provider);
    await act(async () =>
      root.render(
        <RepositoryModule.Provider value={value}>
          <PipelineJobView
            filters={DEFAULT_PIPELINES_FILTERS}
            pipelineId={4821}
            jobId={998}
            at={null}
          />
        </RepositoryModule.Provider>,
      ),
    );
    await flush();
  }
  const labels = () =>
    [...container.querySelectorAll("button")].map((button) => button.textContent ?? "");

  it("opens the new job after a GitLab job retry", async () => {
    const failed = pipelineJob();
    h.detail = pipelineDetail([failed]);
    h.job = pipelineJobDetail({ job: failed });
    h.actions = [];
    h.navigate.mockClear();
    await renderReady("gitlab");
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    )!;
    await act(async () => retry.click());
    await flush();
    expect(h.actions).toEqual([
      { cwd: "/repo", target: { _tag: "job", id: 998 }, action: "retry" },
    ]);
    expect(h.navigate).toHaveBeenCalledWith({
      to: "/project/$environmentId/$projectId/pipelines/$pipelineId/jobs/$jobId",
      params: { environmentId: "env", projectId: "p", pipelineId: "4821", jobId: "1001" },
      search: {},
    });
  });

  it("offers a running GitHub job no Cancel, since GitHub cancels whole runs", async () => {
    const job = pipelineJob({
      status: "running",
      terminal: false,
      finishedAt: null,
      permissions: { retry: "unknown", cancel: "denied", play: "denied" },
    });
    h.detail = pipelineDetail([job], { pipeline: runningRow });
    h.job = pipelineJobDetail({ job, attempt: 1 });
    await renderReady("github");
    expect(labels()).not.toContain("Cancel");
    expect(labels()).not.toContain("Retry");
  });
});
