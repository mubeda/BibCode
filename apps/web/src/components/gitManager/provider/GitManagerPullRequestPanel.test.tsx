// @vitest-environment happy-dom

import type { GitManagerPullRequestsResult } from "@bibcode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  result: null as GitManagerPullRequestsResult | null,
  pending: false,
  error: null as string | null,
  listRequests: vi.fn(() => ({ kind: "provider-query" })),
  refreshRequests: vi.fn(),
  createPr: vi.fn(async () => ({ _tag: "Success" })),
}));

vi.mock("../../../state/gitManager", () => ({
  gitManagerEnvironment: { listPullRequests: h.listRequests },
}));

vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: h.result,
    isPending: h.pending,
    error: h.error,
    refresh: h.refreshRequests,
  }),
}));

vi.mock("../../../state/sourceControlActions", () => ({
  useGitStackedAction: () => ({ run: h.createPr, isPending: false, error: null }),
}));

vi.mock("../../../lib/utils", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, randomUUID: () => "action-1" };
});

import { GitManagerPullRequestPanel } from "./GitManagerPullRequestPanel";

let container: HTMLDivElement;
let root: Root;

async function renderPanel(onRefresh = vi.fn()) {
  await act(async () =>
    root.render(
      <GitManagerPullRequestPanel
        scope={{ environmentId: "env-a" as never, cwd: "/repo" }}
        onRefresh={onRefresh}
      />,
    ),
  );
  return onRefresh;
}

function button(text: string): HTMLButtonElement {
  const result = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!(result instanceof HTMLButtonElement)) throw new Error(`Missing button: ${text}`);
  return result;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  h.result = null;
  h.pending = false;
  h.error = null;
  h.listRequests.mockClear();
  h.refreshRequests.mockClear();
  h.createPr.mockClear();
  vi.useFakeTimers();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("GitManagerPullRequestPanel", () => {
  it("issues no provider request on mount or after an idle hour", async () => {
    await renderPanel();
    expect(container.textContent).toContain("load only when you choose Refresh");
    expect(h.listRequests).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(60 * 60 * 1_000));
    expect(h.listRequests).not.toHaveBeenCalled();
    expect(h.refreshRequests).not.toHaveBeenCalled();
  });

  it("issues exactly one request per Refresh press", async () => {
    const onRefresh = await renderPanel();
    await act(async () => button("Refresh").click());
    expect(h.listRequests).toHaveBeenCalledOnce();
    expect(h.refreshRequests).not.toHaveBeenCalled();
    expect(onRefresh).toHaveBeenCalledOnce();

    await act(async () => button("Refresh").click());
    expect(h.listRequests).toHaveBeenCalledOnce();
    expect(h.refreshRequests).toHaveBeenCalledOnce();
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it("renders unavailable as explanation and loaded checks as local text", async () => {
    h.result = { status: "unavailable", pullRequests: [], checks: [] };
    await renderPanel();
    await act(async () => button("Refresh").click());
    expect(container.textContent).toContain("unavailable for this repository provider");

    h.result = {
      status: "available",
      pullRequests: [
        {
          number: 42,
          title: "Local author data only",
          url: "https://github.test/42",
          baseBranch: "main",
          headBranch: "feature",
          state: "open",
        },
      ],
      checks: [{ name: "build", state: "SUCCESS", link: null, workflow: "CI" }],
    };
    await renderPanel();
    expect(container.textContent).toContain("Local author data only");
    expect(container.textContent).toContain("build");
    expect(container.querySelector("img")).toBeNull();
  });

  it("creates a pull request through the existing stacked action", async () => {
    await renderPanel();
    await act(async () => button("Create pull request").click());
    expect(h.createPr).toHaveBeenCalledWith({ actionId: "action-1", action: "create_pr" });
  });
});
