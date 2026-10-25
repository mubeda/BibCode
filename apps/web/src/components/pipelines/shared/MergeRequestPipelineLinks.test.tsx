// @vitest-environment happy-dom
import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
} from "@bibcode/client-runtime/connection";
import type {
  PullRequestsChecks as Checks,
  PullRequestsPipeline,
  ScopedProjectRef,
  ServerConfig,
} from "@bibcode/contracts";
import { makeTestExecutionEnvironmentCapabilities } from "@bibcode/shared/testSupport";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  settings: { pipelinesEnabled: true },
  connection: null as SupervisorConnectionState | null,
  config: null as ServerConfig | null,
}));
vi.mock("../../../state/entities", () => ({
  useServerConfigs: () => new Map([["env", h.config]]),
}));
vi.mock("../../../state/environments", () => ({
  useEnvironmentConnectionState: () => ({ data: h.connection }),
}));
vi.mock("../../../hooks/useSettings", () => ({
  usePrimarySettings: (select: (s: typeof h.settings) => unknown) => select(h.settings),
}));
vi.mock("../../../localApi", () => ({
  readLocalApi: () => ({ shell: { openExternal: vi.fn() } }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    className,
  }: {
    to: string;
    params: Record<string, string>;
    children: ReactNode;
    className?: string;
  }) => (
    <a
      data-in-app=""
      className={className}
      href={Object.entries(params).reduce(
        (path, [name, value]) => path.replace(`$${name}`, value),
        to,
      )}
    >
      {children}
    </a>
  ),
}));

import { PullRequestsChecks } from "../../pullRequests/detail/PullRequestsChecks";
import { PullRequestsPipelineSummary } from "../../pullRequests/detail/PullRequestsPipelineSummary";
import { context as githubContext, gitlabContext } from "../../pullRequests/detail/testFixtures";
import {
  MergeRequestPipelineLinksProvider,
  mergeRequestPipelineLinks,
} from "./MergeRequestPipelineLinks";

const projectRef = { environmentId: "env", projectId: "p" } as ScopedProjectRef;

const check = (extra: Partial<Checks["groups"][number]["checks"][number]>) => ({
  name: "unit",
  state: "success" as const,
  url: "https://gitlab.example/team/repo/-/jobs/998",
  startedAt: null,
  completedAt: null,
  durationSeconds: null,
  ...extra,
});

const checks = (rows: Checks["groups"][number]["checks"]): Checks => ({
  groups: [{ name: "test", checks: rows }],
  summary: "success",
  pipelineUrl: "https://gitlab.example/team/repo/-/pipelines/4821",
});

const pipeline: PullRequestsPipeline = {
  _tag: "present",
  id: 4821,
  status: "success",
  warnings: false,
  kind: "merge_request",
  ref: "refs/merge-requests/42/head",
  sha: "abc1234def",
  isForHead: true,
  url: "https://gitlab.example/team/repo/-/pipelines/4821",
  updatedAt: "2026-10-24T10:00:00Z",
  startedAt: null,
  finishedAt: null,
  durationSeconds: null,
  stages: null,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  h.settings = { pipelinesEnabled: true };
  h.connection = {
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    phase: "connected",
    network: "online",
  };
  h.config = {
    environment: {
      capabilities: makeTestExecutionEnvironmentCapabilities({ pipelinesReads: true }),
    },
  } as ServerConfig;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(children: ReactNode) {
  act(() =>
    root.render(
      <MergeRequestPipelineLinksProvider projectRef={projectRef}>
        {children}
      </MergeRequestPipelineLinksProvider>,
    ),
  );
}

const links = () =>
  [...container.querySelectorAll("a")].map((a) => ({
    text: a.textContent,
    href: a.getAttribute("href"),
    inApp: a.hasAttribute("data-in-app"),
  }));

describe("merge request pipeline links", () => {
  it("opens a job with route ids on its job page and keeps the host page beside it", () => {
    render(
      <PullRequestsChecks
        checks={checks([check({ pipelineId: 4821, jobId: 998 })])}
        context={gitlabContext}
      />,
    );
    expect(links()).toEqual([
      {
        text: "Open pipeline",
        href: "https://gitlab.example/team/repo/-/pipelines/4821",
        inApp: false,
      },
      { text: "unit", href: "/project/env/p/pipelines/4821/jobs/998", inApp: true },
      {
        text: "Open on GitLab",
        href: "https://gitlab.example/team/repo/-/jobs/998",
        inApp: false,
      },
    ]);
  });

  it("names GitHub as the host for a GitHub job", () => {
    render(
      <PullRequestsChecks
        checks={checks([
          check({
            url: "https://github.com/openai/codex/actions/runs/123/job/456",
            pipelineId: 123,
            jobId: 456,
          }),
        ])}
        context={githubContext}
      />,
    );
    expect(links().map((link) => link.text)).toContain("Open on GitHub");
    expect(links().find((link) => link.inApp)?.href).toBe("/project/env/p/pipelines/123/jobs/456");
  });

  it.each([
    ["Pipelines is off in Settings", () => (h.settings = { pipelinesEnabled: false })],
    [
      "the server has no Pipelines reads",
      () =>
        (h.config = {
          environment: {
            capabilities: makeTestExecutionEnvironmentCapabilities({ pipelinesReads: false }),
          },
        } as ServerConfig),
    ],
    [
      "the environment is disconnected",
      () => (h.connection = { ...AVAILABLE_CONNECTION_STATE, desired: true }),
    ],
  ])("keeps only the host links when %s", (_reason, arrange) => {
    arrange();
    render(
      <>
        <PullRequestsChecks
          checks={checks([check({ pipelineId: 4821, jobId: 998 })])}
          context={gitlabContext}
        />
        <PullRequestsPipelineSummary pipeline={pipeline} branch="feature" settled />
      </>,
    );
    expect(links().some((link) => link.inApp)).toBe(false);
    expect(container.textContent).not.toContain("Open on GitLab");
    expect(container.textContent).not.toContain("View pipeline");
    expect(links().find((link) => link.text === "unit")?.href).toBe(
      "https://gitlab.example/team/repo/-/jobs/998",
    );
  });

  it("keeps the host link for a check an older server sent without route ids", () => {
    render(<PullRequestsChecks checks={checks([check({})])} context={gitlabContext} />);
    expect(links().find((link) => link.text === "unit")).toEqual({
      text: "unit",
      href: "https://gitlab.example/team/repo/-/jobs/998",
      inApp: false,
    });
    expect(container.textContent).not.toContain("Open on GitLab");
  });

  it("gives the pipeline summary a View pipeline link to the pipeline page", () => {
    render(<PullRequestsPipelineSummary pipeline={pipeline} branch="feature" settled />);
    expect(links()).toContainEqual({
      text: "View pipeline",
      href: "/project/env/p/pipelines/4821",
      inApp: true,
    });
    expect(links()).toContainEqual({
      text: "#4821",
      href: "https://gitlab.example/team/repo/-/pipelines/4821",
      inApp: false,
    });
  });

  it("answers no link without both route ids", () => {
    const ready = mergeRequestPipelineLinks(projectRef, true);
    expect(ready.job({ jobId: 998 })).toBeNull();
    expect(ready.job({ pipelineId: 4821 })).toBeNull();
    expect(ready.job({ pipelineId: 4821, jobId: 998 })).not.toBeNull();
    const off = mergeRequestPipelineLinks(projectRef, false);
    expect(off.job({ pipelineId: 4821, jobId: 998 })).toBeNull();
    expect(off.pipeline(4821)).toBeNull();
  });
});
