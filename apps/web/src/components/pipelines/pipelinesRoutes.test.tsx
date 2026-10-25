// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vite-plus/test";
vi.mock("./PipelinesPanel", () => ({ PipelinesPanel: () => null }));
vi.mock("../../state/entities", () => ({ useProject: () => null }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../state/shell", () => ({ environmentShell: { stateAtom: () => null } }));
vi.mock("../../routes/-ChatRouteInset", () => ({ ChatRouteInset: () => null }));
import { Route } from "../../routes/_chat.project.$environmentId.$projectId.pipelines.$pipelineId";

describe("Pipeline route", () => {
  it("keeps a whole attempt number and drops anything else", () => {
    const validate = Route.options.validateSearch;
    if (typeof validate !== "function") throw new Error("Missing search validation");
    expect(validate({})).toEqual({});
    expect(validate({ attempt: 2 })).toEqual({ attempt: 2 });
    expect(validate({ attempt: "3" })).toEqual({ attempt: 3 });
    for (const attempt of [0, -1, 1.5, "x", null]) expect(validate({ attempt })).toEqual({});
  });

  it.each(["nope", "1.5", "0", "-1", "Infinity", "1e2", "9007199254740993"])(
    "redirects pipeline id %s to the project's pipelines",
    (pipelineId) => {
      const load = Route.options.beforeLoad;
      if (typeof load !== "function") throw new Error("Missing id validation");
      try {
        load({ params: { environmentId: "env", projectId: "project", pipelineId } } as never);
        throw new Error("Expected redirect");
      } catch (error) {
        expect(error).toMatchObject({
          options: {
            to: "/project/$environmentId/$projectId/pipelines",
            params: { environmentId: "env", projectId: "project" },
            replace: true,
          },
        });
      }
    },
  );

  it("accepts a host's global pipeline id", () => {
    expect(() =>
      Route.options.beforeLoad!({
        params: { environmentId: "env", projectId: "project", pipelineId: "2109876543" },
      } as never),
    ).not.toThrow();
  });
});
