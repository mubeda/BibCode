// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vite-plus/test";
vi.mock("./PullRequestsPanel", () => ({ PullRequestsPanel: () => null }));
vi.mock("../../state/entities", () => ({ useProject: () => null }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../state/shell", () => ({ environmentShell: { stateAtom: () => null } }));
vi.mock("../../routes/-ChatRouteInset", () => ({ ChatRouteInset: () => null }));
import { Route } from "../../routes/_chat.project.$environmentId.$projectId.pull-requests.$number";
describe("Pull Requests detail route", () => {
  it("defaults invalid tabs and preserves each supported tab", () => {
    const validate = Route.options.validateSearch;
    if (typeof validate !== "function") throw new Error("Missing search validation");
    expect(validate({ tab: "invalid", extra: true })).toEqual({ tab: "conversation" });
    for (const tab of ["conversation", "commits", "checks", "files"])
      expect(validate({ tab })).toEqual({ tab });
  });
  it.each(["nope", "1.5", "0", "-1", "Infinity", "1e2"])(
    "redirects invalid number %s to the project list",
    (number) => {
      const load = Route.options.beforeLoad;
      if (typeof load !== "function") throw new Error("Missing number validation");
      try {
        load({ params: { environmentId: "env", projectId: "project", number } } as never);
        throw new Error("Expected redirect");
      } catch (error) {
        expect(error).toMatchObject({
          options: {
            to: "/project/$environmentId/$projectId/pull-requests",
            params: { environmentId: "env", projectId: "project" },
            replace: true,
          },
        });
      }
    },
  );
  it("accepts an integer number", () => {
    expect(() =>
      Route.options.beforeLoad!({
        params: { environmentId: "env", projectId: "project", number: "14" },
      } as never),
    ).not.toThrow();
  });
});
