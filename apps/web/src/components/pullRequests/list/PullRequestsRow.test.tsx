import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ReactNode } from "react";
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    params,
    children,
  }: {
    params: { environmentId: string; projectId: string; number: string };
    children: ReactNode;
  }) => (
    <a href={`/project/${params.environmentId}/${params.projectId}/pull-requests/${params.number}`}>
      {children}
    </a>
  ),
}));
import { context, row } from "../testFixtures";
import { PullRequestsRow } from "./PullRequestsRow";
const projectRef = { environmentId: "env", projectId: "p" } as never;
describe("PullRequestsRow", () => {
  it("renders a detail link, review/check status, labels and positive comment count", () => {
    const markup = renderToStaticMarkup(
      <PullRequestsRow row={row} projectRef={projectRef} context={context} />,
    );
    expect(markup).toContain("/project/env/p/pull-requests/14");
    expect(markup).toContain("Fix connection recovery");
    expect(markup).toContain("Approved");
    expect(markup).toContain('aria-label="Checks passed"');
    expect(markup).toContain('aria-label="3 comments"');
    expect(markup).toContain("#14 opened");
    expect(markup).toContain("bug");
  });
  it("does not invent a comment badge for search-mode zero counts", () => {
    const markup = renderToStaticMarkup(
      <PullRequestsRow
        row={{ ...row, commentCount: 0, checksSummary: null }}
        projectRef={projectRef}
        context={context}
      />,
    );
    expect(markup).not.toContain('comments"');
    expect(markup).not.toContain("lucide-message-square");
    expect(markup).not.toContain("Checks passed");
  });
  it("uses host row vocabulary and renders approval and unresolved counts", () => {
    const markup = renderToStaticMarkup(
      <PullRequestsRow
        row={{
          ...row,
          isDraft: true,
          approvals: { approved: 1, required: 2 },
          unresolvedThreads: 2,
        }}
        projectRef={projectRef}
        context={{
          ...context,
          capabilities: { ...context.capabilities, closedTabIncludesMerged: false },
        }}
      />,
    );
    expect(markup).toContain("!14 · created");
    expect(markup).toContain("Alice Example");
    expect(markup).toContain("approvals 1 of 2");
    expect(markup).toContain("2 unresolved");
    expect(markup).toContain("Draft");
    expect(markup).toContain("updated");
    expect(markup).not.toContain("<img");
  });
});
