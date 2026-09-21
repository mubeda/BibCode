// @vitest-environment happy-dom
import { projectRef } from "../review/testHelpers";
import { renderReviewMarkup as renderToStaticMarkup } from "../review/testHelpers";
import { describe, expect, it } from "vite-plus/test";
import { PullRequestsSideColumn } from "./PullRequestsSideColumn";
import { context, detail, gitlabContext } from "./testFixtures";
const populated = {
  ...detail,
  reviewers: (
    [
      "unreviewed",
      "commented",
      "approved",
      "changes_requested",
      "dismissed",
      "review_started",
    ] as const
  ).map((state) => ({ actor: { ...detail.author, login: state }, state, canRerequest: false })),
  assignees: [detail.author],
  milestone: { id: "m", title: "Next release", dueOn: null },
  linkedIssues: [
    { reference: "#99", title: "A linked issue", url: "https://example.com/issues/99" },
  ],
  approvalRules: [
    {
      name: "Security",
      approved: 1,
      required: 2,
      approvers: [{ login: "security-reviewer", name: null, isBot: false }],
    },
  ],
};
describe("PullRequestsSideColumn", () => {
  it("shows reviewers and their distinct state, metadata, linked issues and permission reasons", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <PullRequestsSideColumn
        scope={{ environmentId: projectRef.environmentId, cwd: "/repo" }}
        projectRef={projectRef}
        detail={populated}
        context={context}
      />,
    );
    expect(container.querySelector("h2")?.textContent).toBe(
      context.capabilities.vocabulary.reviewer,
    );
    for (const label of [
      "Reviewers",
      "Assignees",
      "Labels",
      "Milestone",
      "Linked issues",
      "Next release",
      "#99",
      "bug",
    ])
      expect(container.textContent).toContain(label);
    for (const label of [
      "Unreviewed",
      "Commented",
      "Approved",
      "Changes requested",
      "Dismissed",
      "Review started",
    ])
      expect(container.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons).toHaveLength(4);
    expect(container.textContent).toContain("From the description");
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
      expect(button.title).toBe(detail.permissions.editPullRequest.reason);
      expect(
        container.querySelector(`[id="${button.getAttribute("aria-describedby")}"]`)?.textContent,
      ).toBe(button.title);
    }
    expect(
      container.querySelector<HTMLAnchorElement>('a[href="https://example.com/issues/99"]')?.rel,
    ).toBe("noreferrer");
  });
  it("shows x of y approval rules with names only for GitLab", () => {
    const render = (host: typeof context) =>
      renderToStaticMarkup(
        <PullRequestsSideColumn
          scope={{ environmentId: projectRef.environmentId, cwd: "/repo" }}
          projectRef={projectRef}
          detail={populated}
          context={host}
        />,
      );
    expect(render(gitlabContext)).toContain("1 of 2");
    expect(render(gitlabContext)).toContain("Security");
    expect(render(gitlabContext)).toContain("security-reviewer");
    expect(render(context)).not.toContain("Approval rules");
  });
});
