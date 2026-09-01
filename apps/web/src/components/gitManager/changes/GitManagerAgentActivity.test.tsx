import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  shells: [] as Array<{
    worktreePath: string | null;
    session: { status: string } | null;
  }>,
}));

vi.mock("../../../state/entities", () => ({
  useThreadShellsForProjectRefs: () => h.shells,
}));

import { GitManagerAgentActivity } from "./GitManagerAgentActivity";

const projectRef = { environmentId: "environment-1", projectId: "project-1" } as never;

beforeEach(() => {
  h.shells = [];
});

describe("GitManagerAgentActivity", () => {
  it("does not light up for a running session in a different worktree", () => {
    h.shells = [{ worktreePath: "/repo/other", session: { status: "running" } }];

    const markup = renderToStaticMarkup(
      <GitManagerAgentActivity
        projectRef={projectRef}
        cwd="/repo/selected"
        mainCheckoutCwd="/repo/main"
      />,
    );

    expect(markup).toBe("");
  });

  it("counts starting and running sessions in the selected checkout", () => {
    h.shells = [
      { worktreePath: null, session: { status: "starting" } },
      { worktreePath: null, session: { status: "running" } },
      { worktreePath: null, session: { status: "ready" } },
    ];

    const markup = renderToStaticMarkup(
      <GitManagerAgentActivity
        projectRef={projectRef}
        cwd="/repo/main"
        mainCheckoutCwd="/repo/main"
      />,
    );

    expect(markup).toContain("2 agent sessions active");
  });
});
