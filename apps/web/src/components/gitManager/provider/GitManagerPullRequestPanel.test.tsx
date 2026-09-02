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
  dialogProps: [] as Array<Record<string, unknown>>,
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

vi.mock("./GitManagerCreatePullRequestDialog", () => ({
  GitManagerCreatePullRequestDialog: (props: Record<string, unknown>) => {
    h.dialogProps.push(props);
    return <div data-testid="create-pr-dialog" role="dialog" />;
  },
}));

import { GitManagerPullRequestPanel } from "./GitManagerPullRequestPanel";

let container: HTMLDivElement;
let root: Root;

async function renderPanel(onRefresh = vi.fn(), disabledReason: string | null = null) {
  await act(async () =>
    root.render(
      <GitManagerPullRequestPanel
        disabledReason={disabledReason}
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
  h.dialogProps = [];
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

  it("disables provider actions with their reason while the rest of the pane remains", async () => {
    const reason = "This environment does not support Git Manager pull request operations.";
    const onRefresh = await renderPanel(vi.fn(), reason);

    expect(container.textContent).toContain("Pull requests and checks");
    expect(container.textContent).toContain(reason);
    expect(button("Create pull request")).toMatchObject({ disabled: true, title: reason });
    expect(button("Refresh")).toMatchObject({ disabled: true, title: reason });
    expect(h.listRequests).not.toHaveBeenCalled();
    expect(h.createPr).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
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

  it("opens the review surface without publishing or creating anything", async () => {
    const onRefresh = await renderPanel();
    expect(container.querySelector('[data-testid="create-pr-dialog"]')).toBeNull();

    await act(async () => button("Create pull request").click());

    expect(container.querySelector('[data-testid="create-pr-dialog"]')).not.toBeNull();
    expect(h.createPr).not.toHaveBeenCalled();
    expect(h.listRequests).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
    const dialog = h.dialogProps.at(-1);
    if (dialog === undefined) throw new Error("The review dialog did not render.");
    expect(dialog).toMatchObject({
      open: true,
      scope: { environmentId: "env-a", cwd: "/repo" },
    });
    const onSettled = dialog.onSettled as () => void;
    const onOpenChange = dialog.onOpenChange as (open: boolean) => void;

    // A settled pull request refreshes the pane the same way Refresh does.
    await act(async () => onSettled());
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(h.listRequests).toHaveBeenCalledOnce();

    await act(async () => onOpenChange(false));
    expect(container.querySelector('[data-testid="create-pr-dialog"]')).toBeNull();
    expect(h.createPr).not.toHaveBeenCalled();
  });
});
