// @vitest-environment happy-dom
import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
} from "@bibcode/client-runtime/connection";
import { environmentRpcKey } from "@bibcode/client-runtime/state/runtime";
import type { PullRequestsContext, ScopedProjectRef, ServerConfig } from "@bibcode/contracts";
import { makeTestExecutionEnvironmentCapabilities } from "@bibcode/shared/testSupport";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_PIPELINES_FILTERS, usePipelinesStore } from "../../pipelinesStore";
import { usePullRequestsStore } from "../../pullRequestsStore";
import { gitlabContext } from "../pullRequests/detail/testFixtures";
import { context as githubContext } from "../pullRequests/testFixtures";
import { buildPipelinesListInput } from "./list/pipelinesList.logic";

const h = vi.hoisted(() => ({
  settings: { pullRequestsEnabled: true, pipelinesEnabled: true },
  connection: null as SupervisorConnectionState | null,
  config: null as ServerConfig | null,
  context: null as PullRequestsContext | null,
  pending: false,
  getContext: vi.fn((args: unknown) => ({ kind: "context", args })),
  list: vi.fn((args: unknown) => ({ kind: "pipelinesList", args })),
  navigate: vi.fn(),
  listProps: null as Record<string, unknown> | null,
  detailProps: null as Record<string, unknown> | null,
  jobLink: null as unknown,
  freshPageKey: null as string | null,
}));
vi.mock("../../state/entities", () => ({
  useProject: () => ({ id: "project", workspaceRoot: "/repo" }),
  useServerConfigs: () => new Map([["env", h.config]]),
}));
vi.mock("../../state/environments", () => ({
  useEnvironmentConnectionState: () => ({ data: h.connection }),
}));
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: (select: (s: typeof h.settings) => unknown) => select(h.settings),
}));
vi.mock("../../state/pullRequests", () => ({
  pullRequestsEnvironment: { getContext: h.getContext, requestContextRescan: vi.fn() },
}));
vi.mock("../../state/pipelines", () => ({ pipelinesEnvironment: { list: h.list } }));
vi.mock("../../state/worktrees", () => ({
  worktreeEnvironment: { catalog: vi.fn(() => ({ kind: "catalog" })) },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { kind: string } | null) => ({
    data:
      atom?.kind === "context" ? h.context : atom?.kind === "catalog" ? { worktrees: [] } : null,
    emission: { _tag: "Initial" },
    error: null,
    isPending: atom?.kind === "context" ? h.pending : false,
    refresh: vi.fn(),
    revalidate: vi.fn(),
    requiresRetry: false,
  }),
}));
vi.mock("../../lib/openPullRequestLink", () => ({ useOpenPrLink: () => vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
  useNavigate: () => h.navigate,
}));
vi.mock("./list/PipelinesListView", async () => {
  const { useRepositoryModule } = await import("../repositoryModule/RepositoryModule");
  return {
    PipelinesListView: (props: Record<string, unknown>) => {
      h.listProps = props;
      h.freshPageKey = useRepositoryModule().state.freshPageKey;
      return <div>Pipelines list</div>;
    },
  };
});

vi.mock("./detail/PipelinesDetailView", async () => {
  const { usePipelineLinks } = await import("./detail/PipelineLinks");
  return {
    PipelinesDetailView: (props: Record<string, unknown>) => {
      h.detailProps = props;
      h.jobLink = usePipelineLinks().jobLink(998);
      return <div>Pipeline detail</div>;
    },
  };
});

import { PipelinesPanel } from "./PipelinesPanel";

const ref = { environmentId: "env", projectId: "project" } as ScopedProjectRef;
let container: HTMLDivElement;
let root: Root;
async function render(search = {}) {
  await act(async () => root.render(<PipelinesPanel projectRef={ref} search={search} />));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  usePullRequestsStore.setState({ byProjectKey: {} });
  usePipelinesStore.setState({ byProjectKey: {} });
  h.settings = { pullRequestsEnabled: true, pipelinesEnabled: true };
  h.connection = {
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    phase: "connected",
    network: "online",
  };
  h.config = {
    environment: {
      capabilities: makeTestExecutionEnvironmentCapabilities({
        pullRequestsReads: true,
        pipelinesReads: true,
      }),
    },
  } as ServerConfig;
  h.context = gitlabContext;
  h.pending = false;
  h.getContext.mockClear();
  h.list.mockClear();
  h.navigate.mockClear();
  h.listProps = null;
  h.detailProps = null;
  h.jobLink = null;
  h.freshPageKey = null;
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("PipelinesPanel", () => {
  it("follows its own setting, not the Pull Requests one", async () => {
    h.settings = { pullRequestsEnabled: true, pipelinesEnabled: false };
    await render();
    expect(container.querySelector('[aria-label="Pipelines unavailable"]')).not.toBeNull();
    expect(container.textContent).toContain(
      "Pipelines are turned off in Settings → Source Control.",
    );
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/settings/source-control");
    expect(h.getContext).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
  });

  it("asks for a server update when the server has Pull Requests but not Pipelines", async () => {
    h.config = {
      environment: {
        capabilities: makeTestExecutionEnvironmentCapabilities({ pullRequestsReads: true }),
      },
    } as ServerConfig;
    await render();
    expect(container.textContent).toContain("Update this environment's server to use Pipelines.");
    expect(h.getContext).not.toHaveBeenCalled();
  });

  it("reads the shared repository context and shows the list with the project's filters", async () => {
    await render();
    expect(h.getContext).toHaveBeenCalledWith({ environmentId: "env", input: { cwd: "/repo" } });
    expect(container.querySelector('section[aria-label="Pipelines"]')).not.toBeNull();
    expect(container.textContent).toContain(gitlabContext.repository);
    expect(container.textContent).toContain("Open on GitLab");
    expect(h.listProps?.filters).toEqual(DEFAULT_PIPELINES_FILTERS);
  });

  it("reads the first page alongside a pending context, and hands it to the list", async () => {
    h.context = null;
    h.pending = true;
    await render({ ref: "release" });
    const input = buildPipelinesListInput(
      { ...DEFAULT_PIPELINES_FILTERS, ref: "release" },
      "/repo",
    );
    expect(h.list).toHaveBeenCalledWith({ environmentId: "env", input });
    h.pending = false;
    h.context = gitlabContext;
    await render({ ref: "release" });
    expect(h.freshPageKey).toBe(environmentRpcKey({ environmentId: "env" as never, input }));
  });

  it("lists a GitHub repository's workflow runs, with its Actions page beside them", async () => {
    h.context = githubContext;
    await render();
    expect(container.textContent).not.toContain("coming");
    expect(h.listProps).not.toBeNull();
    expect(
      [...container.querySelectorAll("a")].find((a) => a.textContent === "Open on GitHub")?.href,
    ).toBe("https://github.com/owner/repo/actions");
  });

  it("writes a filter change to the URL and remembers it for the project", async () => {
    await render();
    const onFiltersChange = h.listProps?.onFiltersChange as (filters: unknown) => void;
    await act(async () => onFiltersChange({ ...DEFAULT_PIPELINES_FILTERS, ref: "main" }));
    expect(h.navigate).toHaveBeenCalledWith({
      to: "/project/$environmentId/$projectId/pipelines",
      params: { environmentId: "env", projectId: "project" },
      search: { ref: "main" },
      replace: true,
    });
    expect(usePipelinesStore.getState().selectViewState(ref).filters.ref).toBe("main");
  });

  it("opens on the route's filters over the stored ones, and remembers them", async () => {
    usePipelinesStore
      .getState()
      .setFilters(ref, { ...DEFAULT_PIPELINES_FILTERS, scope: "running" });
    await render({ scope: "finished" });
    expect(h.listProps?.filters).toEqual({ ...DEFAULT_PIPELINES_FILTERS, scope: "finished" });
    expect(usePipelinesStore.getState().selectViewState(ref).filters.scope).toBe("finished");
    // The sidebar button opens without search: the remembered filters apply.
    await render();
    expect(h.listProps?.filters).toEqual({ ...DEFAULT_PIPELINES_FILTERS, scope: "finished" });
  });

  it("shows one pipeline on its route, without reading the list's first page", async () => {
    usePipelinesStore
      .getState()
      .setFilters(ref, { ...DEFAULT_PIPELINES_FILTERS, scope: "running" });
    h.context = null;
    h.pending = true;
    await act(async () =>
      root.render(<PipelinesPanel projectRef={ref} pipelineId={4821} attempt={null} />),
    );
    expect(h.list).not.toHaveBeenCalled();
    h.pending = false;
    h.context = gitlabContext;
    await act(async () =>
      root.render(<PipelinesPanel projectRef={ref} pipelineId={4821} attempt={2} />),
    );
    expect(h.listProps).toBeNull();
    expect(h.detailProps).toMatchObject({ pipelineId: 4821, attempt: 2 });
    expect(container.textContent).toContain("Refresh");
    // The pipeline's header links to its own host page; the module header does not repeat it.
    expect(container.textContent).not.toContain("Open on GitLab");
    // A pipeline route leaves the remembered list filters alone.
    expect(usePipelinesStore.getState().selectViewState(ref).filters.scope).toBe("running");
  });

  it("opens the pipeline's jobs on their job pages in BiBCode", async () => {
    await act(async () =>
      root.render(<PipelinesPanel projectRef={ref} pipelineId={4821} attempt={null} />),
    );
    expect(h.jobLink).toEqual({
      to: "/project/$environmentId/$projectId/pipelines/$pipelineId/jobs/$jobId",
      params: { environmentId: "env", projectId: "project", pipelineId: "4821", jobId: "998" },
      search: {},
    });
  });
});
