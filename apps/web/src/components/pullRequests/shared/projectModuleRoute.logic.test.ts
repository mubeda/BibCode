import { describe, expect, it } from "vite-plus/test";
import { projectModuleRouteProjectKey } from "./projectModuleRoute.logic";
describe("projectModuleRouteProjectKey", () => {
  const physical = new Map([["scope", "physical"]]);
  const logical = new Map([["physical", "group"]]);
  it.each([
    "/project/e/p/git",
    "/project/e/p/pull-requests",
    "/project/e/p/pull-requests/14",
    "/project/e/p/pipelines",
    "/project/e/p/pipelines/4821",
    "/project/e/p/pipelines/4821/jobs/998",
  ])("highlights the physical project's group on %s", (path) => {
    expect(projectModuleRouteProjectKey(path, "scope", physical, logical)).toBe("group");
  });
  it.each([
    "/git",
    "/project/e/p/git-extra",
    "/project/e/p/pull-requests-else",
    "/project/e/p/pull-requests/14/files",
    "/project/e/p/pull-requests/bad",
    "/project/e/p/pipelines/abc",
    "/project/e/p/pipelines/4821/jobs",
    "/project/e/p/pipelines/4821/jobs/abc",
    "/project/e/p/pipelines-else",
  ])("rejects unrelated path %s", (path) => {
    expect(projectModuleRouteProjectKey(path, "scope", physical, logical)).toBeNull();
  });
  it("handles ungrouped projects and missing route identity", () => {
    expect(projectModuleRouteProjectKey("/project/e/p/git", "scope", new Map(), new Map())).toBe(
      "scope",
    );
    expect(projectModuleRouteProjectKey("/project/e/p/git", null, physical, logical)).toBeNull();
  });
});
