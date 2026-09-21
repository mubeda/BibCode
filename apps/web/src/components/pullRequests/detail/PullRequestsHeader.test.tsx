// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { projectRef, renderReviewMarkup, mockRun } from "../review/testHelpers";
import { PullRequestsActionsContext } from "../usePullRequestsAction";
import { describe, expect, it, vi } from "vite-plus/test";
const h = vi.hoisted(() => ({
  open: vi.fn().mockResolvedValue(undefined),
  copy: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../../localApi", () => ({ readLocalApi: () => ({ shell: { openExternal: h.open } }) }));
vi.mock("../../../hooks/useCopyToClipboard", () => ({ writeTextToClipboard: h.copy }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, refresh: vi.fn(), error: null, isPending: false }),
}));
import { PullRequestsHeader } from "./PullRequestsHeader";
import { context, detail, gitlabContext } from "./testFixtures";
describe("PullRequestsHeader", () => {
  it.each([
    [context, "#14", "wants to merge 3 commits into"],
    [gitlabContext, "!14", "requested to merge"],
  ])("renders host title, number, branches and sentence", (host, number, sentence) => {
    const html = renderReviewMarkup(
      <PullRequestsHeader
        scope={{ environmentId: projectRef.environmentId, cwd: "/repo" }}
        projectRef={projectRef}
        detail={{ ...detail, isCrossRepository: true }}
        context={host}
        onRefresh={() => {}}
        refreshing={false}
      />,
    );
    expect(html).toContain(detail.title);
    expect(html).toContain(number);
    expect(html).toContain(sentence);
    expect(html).toContain("from a fork");
    expect(html).toContain("main");
    expect(html).toContain("feature");
    expect(html).toContain('aria-label="Checkout options"');
    expect(html).not.toContain("Checkout arrives in a later build");
  });
  it.each([
    ["open", false, "Open"],
    ["open", true, "Draft"],
    ["merged", false, "Merged"],
    ["closed", false, "Closed"],
  ] as const)("renders the %s state with a text label", (state, isDraft, label) => {
    const html = renderReviewMarkup(
      <PullRequestsHeader
        scope={{ environmentId: projectRef.environmentId, cwd: "/repo" }}
        projectRef={projectRef}
        detail={{ ...detail, state, isDraft }}
        context={context}
        onRefresh={() => {}}
        refreshing={false}
      />,
    );
    expect(html).toContain(`>${label}<`);
  });
  it("copies the head branch, opens the host, refreshes and explains every overflow placeholder", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const refresh = vi.fn();
    try {
      await act(async () =>
        root.render(
          <PullRequestsActionsContext value={{ run: mockRun(), pending: false, error: null }}>
            <PullRequestsHeader
              scope={{ environmentId: projectRef.environmentId, cwd: "/repo" }}
              projectRef={projectRef}
              detail={detail}
              context={context}
              onRefresh={refresh}
              refreshing={false}
            />
          </PullRequestsActionsContext>,
        ),
      );
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Copy head branch"]')!.click(),
      );
      expect(h.copy).toHaveBeenCalledWith("feature", "branch name");
      await act(async () =>
        container.querySelector<HTMLAnchorElement>(`a[href="${detail.url}"]`)!.click(),
      );
      expect(h.open).toHaveBeenCalledWith(detail.url);
      const button = (label: string) =>
        [...container.querySelectorAll("button")].find((b) => b.textContent === label)!;
      await act(async () => button("Refresh").click());
      expect(refresh).toHaveBeenCalledOnce();
      await act(async () => button("More actions").click());
      const items = [
        ...document.querySelectorAll<HTMLElement>('[role="menuitem"][aria-disabled="true"]'),
      ];
      expect(items.length).toBeGreaterThanOrEqual(3);
      for (const item of items) {
        expect(item.title).toBeTruthy();
        expect(document.getElementById(item.getAttribute("aria-describedby")!)?.textContent).toBe(
          item.title,
        );
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
