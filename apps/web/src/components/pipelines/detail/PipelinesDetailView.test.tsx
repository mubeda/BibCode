// @vitest-environment happy-dom
import {
  EnvironmentId,
  PullRequestsOperationError,
  type PipelinesChanged,
  type PipelinesDetail,
  type PipelinesGetInput,
  type PipelinesSnapshot,
} from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import { act, createRef, useReducer, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_PIPELINES_FILTERS, usePipelinesStore } from "../../../pipelinesStore";
import { PullRequestsContextRefresh } from "../../pullRequests/pullRequestsContextRefresh";
import { gitlabContext } from "../../pullRequests/detail/testFixtures";
import { context as githubContext } from "../../pullRequests/testFixtures";
import {
  RepositoryModule,
  type RepositoryModuleValue,
} from "../../repositoryModule/RepositoryModule";
import { buildPipelinesListInput } from "../list/pipelinesList.logic";
import { pipelinesModule } from "../pipelinesModule";
import { pipelineDetail, pipelineJob } from "../testFixtures";
import { PipelineLinksProvider } from "./PipelineLinks";

const h = vi.hoisted(() => ({
  detail: null as PipelinesDetail | null,
  // Applied to the live copy each time a read answers, for budget runs.
  onAnswer: null as ((detail: PipelinesDetail) => PipelinesDetail) | null,
  error: null as PullRequestsOperationError | null,
  pending: false,
  failures: new Map<object, unknown>(),
  snapshot: null as PipelinesSnapshot | null,
  nextSnapshot: null as PipelinesSnapshot | null,
  changed: null as PipelinesChanged | null,
  streamFailed: false,
  get: vi.fn((args: { input: PipelinesGetInput }) => ({ kind: "get", ...args })),
  readSnapshot: vi.fn((args: { input: unknown }) => ({ kind: "readSnapshot", ...args })),
  subscribe: vi.fn((args: { input: unknown }) => ({ kind: "subscribe", ...args })),
  requestTimerRead: vi.fn(),
  reads: vi.fn(),
  snapshotReads: vi.fn(),
  inflight: [] as (() => void)[],
}));
vi.mock("../../../state/pipelines", () => ({
  pipelinesEnvironment: {
    get: h.get,
    readSnapshot: h.readSnapshot,
    subscribe: h.subscribe,
    requestTimerRead: h.requestTimerRead,
  },
}));
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: (atom: { kind: string } | null) => {
    const [, publish] = useReducer((value: number) => value + 1, 0);
    if (atom !== null && (atom.kind === "readSnapshot" || atom.kind === "subscribe")) {
      const value = atom.kind === "readSnapshot" ? h.snapshot : h.changed;
      const read = () => {
        h.snapshotReads(atom.kind);
        if (atom.kind === "readSnapshot" && h.nextSnapshot) h.snapshot = h.nextSnapshot;
        publish();
      };
      const emission =
        atom.kind === "subscribe" && h.streamFailed
          ? { _tag: "Failure", cause: Cause.fail(new Error("stream down")) }
          : value
            ? { _tag: "Success", value }
            : { _tag: "Initial" };
      return {
        data: value,
        emission,
        error: null,
        isPending: false,
        refresh: read,
        revalidate: read,
        requiresRetry: false,
      };
    }
    if (atom === null || atom.kind !== "get")
      return {
        data: null,
        emission: { _tag: "Initial" },
        error: null,
        isPending: false,
        refresh: () => {},
        revalidate: () => {},
        requiresRetry: false,
      };
    const error = h.error;
    if (error && !h.failures.has(error))
      h.failures.set(error, { _tag: "Failure", cause: Cause.fail(error) });
    const read = () => {
      h.reads();
      h.pending = true;
      publish();
      h.inflight.push(() => {
        h.pending = false;
        if (h.detail) h.detail = h.onAnswer ? h.onAnswer(h.detail) : { ...h.detail };
        if (h.error) h.failures.delete(h.error);
        publish();
      });
    };
    return {
      data: h.detail,
      emission: error ? h.failures.get(error) : { _tag: "Success", value: h.detail },
      error: error?.message ?? null,
      isPending: h.pending,
      refresh: read,
      revalidate: read,
      requiresRetry: false,
    };
  },
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    className,
  }: {
    to: string;
    params?: Record<string, string>;
    children: ReactNode;
    className?: string;
  }) => (
    <a
      data-route={to}
      className={className}
      href={Object.entries(params ?? {}).reduce(
        (path, [name, value]) => path.replace(`$${name}`, value),
        to,
      )}
    >
      {children}
    </a>
  ),
}));
vi.mock("../../../lib/openPullRequestLink", () => ({ useOpenPrLink: () => vi.fn() }));

import { PipelinesDetailView, type PipelinesDetailViewHandle } from "./PipelinesDetailView";

const projectRef = { environmentId: "env", projectId: "p" } as never;
const scope = { environmentId: EnvironmentId.make("env"), cwd: "/repo" };
const SERVER_TOO_OLD = "Update the server to retry and cancel pipelines.";
let container: HTMLDivElement;
let root: Root;
const handle = createRef<PipelinesDetailViewHandle>();
const refreshContext = vi.fn();

function moduleValue(
  repositoryContext: typeof gitlabContext | typeof githubContext,
): RepositoryModuleValue {
  return {
    state: {
      availability: { kind: "ready" },
      project: null,
      cwd: scope.cwd,
      scope,
      context: repositoryContext,
      contextQuery: {} as never,
      storedContext: false,
      worktreeOptions: [],
      worktreeStatus: null,
      freshPageKey: null,
    },
    actions: { rescan: vi.fn(), recover: vi.fn(), setCwd: vi.fn(), consumeFreshPage: vi.fn() },
    meta: { module: pipelinesModule, projectRef, mutationsDisabledReason: SERVER_TOO_OLD },
  };
}

async function settle() {
  await act(async () => {
    for (const answer of h.inflight.splice(0)) answer();
  });
}
async function render(
  options: {
    provider?: "gitlab" | "github";
    attempt?: number | null;
    wrap?: (node: ReactNode) => ReactNode;
  } = {},
) {
  const view = (
    <PipelinesDetailView
      ref={handle}
      pipelineId={4821}
      attempt={options.attempt ?? null}
      onBackoffChange={vi.fn()}
    />
  );
  const value = moduleValue(options.provider === "github" ? githubContext : gitlabContext);
  await act(async () =>
    root.render(
      <PullRequestsContextRefresh value={refreshContext}>
        <RepositoryModule.Provider value={value}>
          {options.wrap ? options.wrap(view) : view}
        </RepositoryModule.Provider>
      </PullRequestsContextRefresh>,
    ),
  );
  await settle();
}
function stored(detail: PipelinesDetail, observedAt = 1_000): PipelinesSnapshot {
  return { list: null, detail: { payload: detail, observedAt }, job: null };
}
function link(text: string) {
  const found = [...container.querySelectorAll("a")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Missing link ${text}`);
  return found;
}
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
function operationError(code: string, message: string) {
  return new PullRequestsOperationError({
    operation: "pipelines.get",
    code: code as never,
    message,
    hostDetail: null,
    retryable: false,
  });
}
function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  usePipelinesStore.setState({ byProjectKey: {} });
  h.detail = pipelineDetail();
  h.onAnswer = null;
  h.error = null;
  h.pending = false;
  h.failures.clear();
  h.snapshot = null;
  h.nextSnapshot = null;
  h.changed = null;
  h.streamFailed = false;
  for (const mock of [
    h.get,
    h.readSnapshot,
    h.subscribe,
    h.requestTimerRead,
    h.reads,
    h.snapshotReads,
    refreshContext,
  ])
    mock.mockClear();
  h.inflight = [];
  setVisibility("visible");
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("PipelinesDetailView header", () => {
  it("shows the status, title, number, creator, commit, ref, job count and times", async () => {
    await render();
    const header = container.querySelector("header")!;
    expect(header.textContent).toContain("Failed");
    expect(header.querySelector("h2")?.textContent).toBe("Fix connection recovery");
    expect(header.textContent).toMatch(/Pipeline #4821 created .+ by Ana Rossi · finished /);
    expect(link("abc1234").getAttribute("href")).toBe(
      "https://gitlab.com/acme/repo/-/commit/abc1234def5678",
    );
    expect(header.textContent).toContain("main");
    expect(header.textContent).toContain("2 jobs");
    expect(header.textContent).toContain("4m 12s");
    expect(header.textContent).toContain("Queued 5s");
    expect(link("Open on GitLab").getAttribute("href")).toBe(
      "https://gitlab.com/acme/repo/-/pipelines/4821",
    );
  });

  it.each([
    [{ status: "success", warnings: true, reason: null }, "Passed with warnings"],
    [{ status: "waiting", warnings: false, reason: "approval" }, "Waiting for approval"],
    [{ status: "skipped", warnings: false, reason: "neutral" }, "Neutral"],
    [{ status: "running", warnings: false, reason: null, terminal: false }, "Running"],
  ] as const)("names %o as %s", async (pipeline, label) => {
    h.detail = pipelineDetail({ pipeline });
    await render();
    expect(container.querySelector("header")?.textContent).toContain(label);
  });

  it("links a merge request ref to its page in BiBCode", async () => {
    h.detail = pipelineDetail({
      pipeline: { ref: { kind: "merge_request", name: "feature", number: 14, url: null } },
    });
    await render();
    expect(link("!14").getAttribute("href")).toBe("/project/env/p/pull-requests/14");
  });

  it("disables Retry with the server's reason until it offers pipeline actions", async () => {
    await render();
    const retry = button("Retry");
    expect(retry.disabled).toBe(true);
    expect(retry.title).toBe(SERVER_TOO_OLD);
  });
});

describe("PipelinesDetailView stages", () => {
  it("shows GitLab's stages in order, each job opening on the host without a job page link", async () => {
    await render();
    const stages = [...container.querySelectorAll('[aria-label="Stages"] > li')];
    expect(stages.map((stage) => stage.querySelector("h3")?.textContent)).toEqual([
      "build1 job",
      "test1 job",
    ]);
    expect(link("rspec2m 0s").getAttribute("href")).toBe("https://gitlab.com/acme/repo/-/jobs/998");
    expect(button("Retry rspec").title).toBe(SERVER_TOO_OLD);
  });

  it("links jobs in BiBCode when the view provides a job page", async () => {
    await render({
      wrap: (view) => (
        <PipelineLinksProvider
          value={{
            jobLink: (jobId) => ({
              to: "/project/$environmentId/$projectId/pipelines",
              params: { environmentId: "env", projectId: `p-job-${jobId}` },
            }),
          }}
        >
          {view}
        </PipelineLinksProvider>
      ),
    });
    expect(link("rspec2m 0s").getAttribute("href")).toBe("/project/env/p-job-998/pipelines");
  });

  it("folds a parallel group into one row that expands to its jobs", async () => {
    const jobs = [1, 2, 3].map((index) => ({
      ...pipelineJob,
      id: 1_000 + index,
      name: `rspec ${index}/3`,
    }));
    h.detail = pipelineDetail({
      stages: [
        {
          name: "test",
          status: "failed",
          warnings: false,
          groups: [{ name: "rspec", size: 3, status: "failed", jobs }],
        },
      ],
    });
    await render();
    const group = button("rspec3");
    expect(group.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("rspec 2/3");
    await act(async () => group.click());
    expect(group.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("rspec 2/3");
  });

  it("links a trigger job to its downstream pipeline", async () => {
    h.detail = pipelineDetail({
      stages: [
        {
          name: "deploy",
          status: "success",
          warnings: false,
          groups: [
            {
              name: "downstream",
              size: 1,
              status: "success",
              jobs: [
                {
                  ...pipelineJob,
                  kind: "trigger",
                  name: "downstream",
                  status: "success",
                  downstreamUrl: "https://gitlab.com/acme/other/-/pipelines/77",
                },
              ],
            },
          ],
        },
      ],
    });
    await render();
    expect(link("Downstream pipeline").getAttribute("href")).toBe(
      "https://gitlab.com/acme/other/-/pipelines/77",
    );
  });

  it("puts a GitHub run's jobs in one Jobs column", async () => {
    await render({ provider: "github" });
    const stages = [...container.querySelectorAll('[aria-label="Stages"] > li')];
    expect(stages).toHaveLength(1);
    expect(stages[0]?.querySelector("h3")?.textContent).toBe("Jobs2 jobs");
    expect(stages[0]?.textContent).toContain("compile");
    expect(stages[0]?.textContent).toContain("rspec");
  });

  it("says when GitLab returned only the first 100 jobs of a stage", async () => {
    h.detail = pipelineDetail({ truncated: true });
    await render();
    expect(container.textContent).toContain(
      "Showing the first 100 jobs of a stage. Open the pipeline for the rest.",
    );
  });

  it("says how many of a large GitHub run's jobs are shown", async () => {
    h.detail = pipelineDetail({ truncated: true, totalJobs: 1_240 });
    await render({ provider: "github" });
    expect(container.textContent).toContain("Showing the first 1,000 of 1,240 jobs.");
    expect(container.textContent).not.toContain("100 jobs of a stage");
  });

  it("keeps the header when the account cannot read the jobs", async () => {
    h.detail = pipelineDetail({ stages: null });
    await render();
    expect(container.querySelector("header h2")?.textContent).toBe("Fix connection recovery");
    expect(container.textContent).toContain("You can't view this pipeline's jobs.");
  });
});

describe("PipelinesDetailView errors", () => {
  it("shows a refused pipeline on the page, without the sign-in state", async () => {
    h.detail = null;
    h.error = operationError(
      "forbidden",
      "This account does not have permission for this operation.",
    );
    await render();
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("You can't view this pipeline.");
    // Built from the repository's web address, since no read returned the pipeline's link.
    expect(link("Open on GitLab").getAttribute("href")).toBe(
      `${gitlabContext.webUrl}/-/pipelines/4821`,
    );
    expect(container.querySelector("header")).toBeNull();
    expect(link("Back to pipelines").getAttribute("href")).toBe("/project/env/p/pipelines");
    expect(refreshContext).not.toHaveBeenCalled();
  });

  it("says a missing pipeline is gone and leads back to the list", async () => {
    h.detail = null;
    h.error = operationError("not_found", "The requested repository could not be found.");
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "This pipeline no longer exists.",
    );
    expect(link("Back to pipelines").getAttribute("href")).toBe("/project/env/p/pipelines");
  });

  it("hands a lost sign-in to the shell", async () => {
    h.detail = null;
    h.error = operationError("not_authenticated", "Sign in to GitLab.");
    await render();
    expect(refreshContext).toHaveBeenCalled();
  });
});

describe("PipelinesDetailView paint", () => {
  it("paints the stored pipeline before its live read answers", async () => {
    h.detail = null;
    h.pending = true;
    h.snapshot = stored(pipelineDetail({ pipeline: { title: "Stored title" } }));
    await render();
    expect(container.querySelector("header h2")?.textContent).toBe("Stored title");
    expect(h.readSnapshot).toHaveBeenCalledWith({
      environmentId: "env",
      input: {
        ...buildPipelinesListInput(DEFAULT_PIPELINES_FILTERS, "/repo"),
        pipelineId: 4821,
        attempt: null,
        jobId: null,
      },
    });
  });

  it("subscribes with the list key the project's list shows", async () => {
    usePipelinesStore
      .getState()
      .setFilters(projectRef, { ...DEFAULT_PIPELINES_FILTERS, scope: "running" });
    await render();
    expect(h.subscribe).toHaveBeenCalledWith({
      environmentId: "env",
      input: expect.objectContaining({ scope: "running", pipelineId: 4821, jobId: null }),
    });
    expect(h.get).toHaveBeenCalledWith({
      environmentId: "env",
      input: { cwd: "/repo", pipelineId: 4821, attempt: null, refresh: "user" },
    });
  });

  it("keeps a newer poller copy over a slower live answer", async () => {
    h.detail = null;
    h.pending = true;
    h.snapshot = stored(pipelineDetail({ revision: 5, pipeline: { title: "Polled title" } }));
    await render();
    h.pending = false;
    h.detail = pipelineDetail({ revision: 3, pipeline: { title: "Slow live title" } });
    await render();
    expect(container.querySelector("header h2")?.textContent).toBe("Polled title");
    h.detail = pipelineDetail({ revision: 7, pipeline: { title: "Newer live title" } });
    await render();
    expect(container.querySelector("header h2")?.textContent).toBe("Newer live title");
  });

  it("answers a pipeline name from storage, with no host read", async () => {
    await render();
    const opened = h.reads.mock.calls.length;
    h.changed = { list: false, pipeline: true };
    h.nextSnapshot = stored(pipelineDetail({ revision: 9, pipeline: { title: "Polled title" } }));
    await render();
    expect(h.snapshotReads).toHaveBeenCalledWith("readSnapshot");
    expect(container.querySelector("header h2")?.textContent).toBe("Polled title");
    expect(h.reads.mock.calls.length).toBe(opened);
  });

  it("announces a pipeline that finished while shown", async () => {
    h.detail = pipelineDetail({ pipeline: { status: "running", terminal: false } });
    await render();
    h.detail = pipelineDetail({ revision: 2 });
    await render();
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "Pipeline #4821 failed.",
    );
  });
});

describe("PipelinesDetailView request budget", () => {
  const HOUR = 3_600_000;
  async function runFor(ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += 5_000) {
      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      await settle();
    }
  }
  // Each answer moves a job, so the pipeline never goes quiet.
  function changingRun(detail: PipelinesDetail): PipelinesDetail {
    const stages = detail.stages!.map((stage) => ({
      ...stage,
      groups: stage.groups.map((group) => ({
        ...group,
        jobs: group.jobs.map((job) => ({
          ...job,
          status: job.status === "running" ? ("queued" as const) : ("running" as const),
        })),
      })),
    }));
    return { ...detail, revision: detail.revision + 1, stages };
  }

  it("issues no pipeline reads on GitLab after the open while the stream is live", async () => {
    vi.useFakeTimers();
    h.detail = pipelineDetail({ pipeline: { status: "running", terminal: false } });
    h.changed = { list: false, pipeline: false };
    await render();
    const opened = h.reads.mock.calls.length;
    await runFor(HOUR);
    expect(h.requestTimerRead).not.toHaveBeenCalled();
    expect(h.reads.mock.calls.length).toBe(opened);
  });

  it("follows GitLab every 10 s while its stream is down", async () => {
    vi.useFakeTimers();
    h.detail = pipelineDetail({ pipeline: { status: "running", terminal: false } });
    h.onAnswer = changingRun;
    h.streamFailed = true;
    await render();
    await runFor(HOUR);
    expect(h.requestTimerRead.mock.calls.length).toBeGreaterThanOrEqual(359);
    expect(h.requestTimerRead.mock.calls.length).toBeLessThanOrEqual(360);
  });

  it("reads a running one-page GitHub run every 10 s (720 run and jobs reads an hour), then once on finishing", async () => {
    vi.useFakeTimers();
    h.detail = pipelineDetail({ pipeline: { status: "running", terminal: false } });
    h.onAnswer = changingRun;
    await render({ provider: "github" });
    expect(h.subscribe).not.toHaveBeenCalled();
    await runFor(HOUR);
    expect(h.requestTimerRead.mock.calls.length).toBeGreaterThanOrEqual(359);
    expect(h.requestTimerRead.mock.calls.length).toBeLessThanOrEqual(360);

    h.requestTimerRead.mockClear();
    h.onAnswer = (detail) => ({
      ...detail,
      revision: detail.revision + 1,
      pipeline: { ...detail.pipeline, status: "success", terminal: true },
    });
    await runFor(HOUR);
    expect(h.requestTimerRead).toHaveBeenCalledOnce();
  });

  it("slows a GitHub run that has not changed for 30 minutes", async () => {
    vi.useFakeTimers();
    h.detail = pipelineDetail({ pipeline: { status: "running", terminal: false } });
    await render({ provider: "github" });
    await runFor(HOUR);
    // 30 minutes at 10 s, then 30 minutes at 20 s.
    expect(h.requestTimerRead.mock.calls.length).toBeGreaterThanOrEqual(268);
    expect(h.requestTimerRead.mock.calls.length).toBeLessThanOrEqual(271);
  });

  it("issues no timer reads for a finished manual pipeline, or while hidden", async () => {
    vi.useFakeTimers();
    h.detail = pipelineDetail({ pipeline: { status: "manual", terminal: true } });
    await render({ provider: "github" });
    await runFor(HOUR);
    expect(h.requestTimerRead).not.toHaveBeenCalled();

    h.detail = pipelineDetail({ pipeline: { status: "running", terminal: false } });
    await render({ provider: "github" });
    setVisibility("hidden");
    h.requestTimerRead.mockClear();
    await runFor(HOUR);
    expect(h.requestTimerRead).not.toHaveBeenCalled();
  });
});
