// @vitest-environment happy-dom

import type { EnvironmentThreadShell } from "@bibcode/client-runtime/state/models";
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  project: { id: "project-1", workspaceRoot: "/repo" } as {
    id: string;
    workspaceRoot: string;
  } | null,
  threads: [] as EnvironmentThreadShell[],
  childMatches: [] as unknown[],
  detailMatch: undefined as unknown,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: ComponentType }) => ({
    options,
    useParams: () => ({ environmentId: "env-1", projectId: "project-1" }),
    useSearch: () => ({}),
  }),
  Outlet: () => <div data-testid="route-outlet" />,
  useChildMatches: () => h.childMatches,
  useMatch: () => h.detailMatch,
  useNavigate: () => h.navigate,
}));

vi.mock("../state/entities", () => ({
  useProject: () => h.project,
  useThreadShellsForProjectRefs: () => h.threads,
}));

vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { status: "live" } }),
}));

vi.mock("../state/shell", () => ({
  environmentShell: { stateAtom: () => ({ kind: "shell" }) },
}));

vi.mock("./-ChatRouteInset", () => ({
  ChatRouteInset: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="chat-route-inset">{children}</div>
  ),
}));

vi.mock("../components/gitManager/GitManagerPanel", () => ({
  GitManagerPanel: () => <div data-testid="standalone-git-manager" />,
}));

vi.mock("../components/pipelines/PipelinesPanel", () => ({
  PipelinesPanel: () => <div data-testid="standalone-pipelines" />,
}));

vi.mock("../components/pullRequests/PullRequestsPanel", () => ({
  PullRequestsPanel: () => <div data-testid="standalone-pull-requests" />,
}));

import { Route as GitRoute } from "./_chat.project.$environmentId.$projectId.git";
import { Route as PipelinesRoute } from "./_chat.project.$environmentId.$projectId.pipelines";
import { Route as PullRequestsRoute } from "./_chat.project.$environmentId.$projectId.pull-requests";

function makeThread(
  id: string,
  updatedAt: string,
  options: { archivedAt?: string | null; kind?: "default" | "workspace" | "panel" } = {},
): EnvironmentThreadShell {
  return {
    id,
    environmentId: "env-1",
    projectId: "project-1",
    title: `Thread ${id}`,
    branch: "main",
    updatedAt,
    archivedAt: options.archivedAt ?? null,
    kind: options.kind ?? "workspace",
  } as unknown as EnvironmentThreadShell;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  useRightPanelStore.setState({ byThreadKey: {} });
  h.navigate.mockReset();
  h.project = { id: "project-1", workspaceRoot: "/repo" };
  h.threads = [];
  h.childMatches = [];
  h.detailMatch = undefined;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("project surface root routes", () => {
  for (const [name, route, kind, standaloneTestId] of [
    ["git", GitRoute, "gitManager", "standalone-git-manager"],
    ["pipelines", PipelinesRoute, "pipelines", "standalone-pipelines"],
    ["pull-requests", PullRequestsRoute, "pullRequest", "standalone-pull-requests"],
  ] as const) {
    it(`redirects ${name} to the best eligible host thread and opens ${kind} in its right panel`, async () => {
      h.threads = [
        makeThread("older-live", "2026-10-01T00:00:00.000Z"),
        makeThread("newest-live", "2026-10-10T00:00:00.000Z"),
        makeThread("newest-panel", "2026-10-15T00:00:00.000Z", { kind: "panel" }),
        makeThread("newest-archived", "2026-10-20T00:00:00.000Z", {
          archivedAt: "2026-10-20T01:00:00.000Z",
        }),
      ];
      const Component = route.options.component as ComponentType;
      await act(async () => root.render(<Component />));

      expect(container.querySelector(`[data-testid="${standaloneTestId}"]`)).toBeNull();
      expect(h.navigate).toHaveBeenCalledWith({
        to: "/$environmentId/$threadId",
        params: { environmentId: "env-1", threadId: "newest-live" },
        replace: true,
      });
      const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, {
        environmentId: "env-1" as never,
        threadId: "newest-live" as never,
      });
      expect(panel.isOpen).toBe(true);
      expect(panel.activeSurfaceId).toBe(kind);
    });

    it(`falls back to the standalone ${name} panel when zero eligible host threads exist`, async () => {
      h.threads = [
        makeThread("panel-only", "2026-10-15T00:00:00.000Z", { kind: "panel" }),
        makeThread("archived-only", "2026-10-20T00:00:00.000Z", {
          archivedAt: "2026-10-20T01:00:00.000Z",
        }),
      ];
      const Component = route.options.component as ComponentType;
      await act(async () => root.render(<Component />));

      expect(container.querySelector(`[data-testid="${standaloneTestId}"]`)).not.toBeNull();
      expect(h.navigate).not.toHaveBeenCalled();
    });
  }

  it("keeps child detail routes mounted as standalone pages even when eligible threads exist", async () => {
    h.threads = [makeThread("live", "2026-10-10T00:00:00.000Z")];
    h.childMatches = [{ id: "child" }];
    h.detailMatch = { id: "detail" };

    const PipelinesComponent = PipelinesRoute.options.component as ComponentType;
    await act(async () => root.render(<PipelinesComponent />));
    expect(container.querySelector('[data-testid="route-outlet"]')).not.toBeNull();
    expect(h.navigate).not.toHaveBeenCalled();

    const PullRequestsComponent = PullRequestsRoute.options.component as ComponentType;
    await act(async () => root.render(<PullRequestsComponent />));
    expect(container.querySelector('[data-testid="route-outlet"]')).not.toBeNull();
    expect(h.navigate).not.toHaveBeenCalled();
  });
});
