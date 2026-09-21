// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
const h = vi.hoisted(() => ({ open: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../../localApi", () => ({ readLocalApi: () => ({ shell: { openExternal: h.open } }) }));
import { PullRequestsChecks } from "./PullRequestsChecks";
import { context, gitlabContext } from "./testFixtures";
describe("PullRequestsChecks", () => {
  it("uses the supplied request vocabulary in the pipeline empty state", () => {
    const host = {
      ...gitlabContext,
      capabilities: {
        ...gitlabContext.capabilities,
        vocabulary: { ...gitlabContext.capabilities.vocabulary, pullRequest: "review request" },
      },
    };
    const html = renderToStaticMarkup(
      <PullRequestsChecks
        checks={{ groups: [], summary: "none", pipelineUrl: null }}
        context={host}
      />,
    );
    expect(html).toContain("No pipeline for this review request");
  });
  it.each([
    [context, "No checks reported"],
    [gitlabContext, "No pipeline for this merge request"],
  ])("uses the host's empty checks copy", (host, text) => {
    expect(
      renderToStaticMarkup(
        <PullRequestsChecks
          checks={{ groups: [], summary: "none", pipelineUrl: null }}
          context={host}
        />,
      ),
    ).toContain(text);
  });
  it("renders collapsible groups, summary, all states, duration and pipeline/check links", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);
    const checks = {
      summary: "failure" as const,
      pipelineUrl: "https://example.com/pipeline/1",
      groups: [
        {
          name: "build",
          checks: (
            ["pending", "success", "failure", "cancelled", "skipped", "neutral"] as const
          ).map((state) => ({
            name: `Job ${state}`,
            state,
            url: `https://example.com/job/${state}`,
            startedAt: null,
            completedAt: null,
            durationSeconds: state === "success" ? 65 : null,
          })),
        },
      ],
    };
    try {
      await act(async () =>
        root.render(<PullRequestsChecks checks={checks} context={gitlabContext} />),
      );
      expect(container.textContent).toContain("Checks failed");
      expect(container.querySelector("summary")?.textContent).toContain("build 6");
      for (const state of ["pending", "success", "failure", "cancelled", "skipped", "neutral"])
        expect(container.querySelector(`[aria-label="${state}"]`)).not.toBeNull();
      expect(container.textContent).toContain("1m 5s");
      expect(container.querySelector("details")?.open).toBe(true);
      await act(async () =>
        container
          .querySelector<HTMLAnchorElement>('a[href="https://example.com/pipeline/1"]')!
          .click(),
      );
      expect(h.open).toHaveBeenCalledWith(checks.pipelineUrl);
      await act(async () =>
        container
          .querySelector<HTMLAnchorElement>('a[href="https://example.com/job/success"]')!
          .click(),
      );
      expect(h.open).toHaveBeenCalledWith("https://example.com/job/success");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
