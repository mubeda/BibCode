import { ProviderDriverKind, type ServerTool } from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isToolId, toolAsProvider, toolsAsProviders, updateSubjects } from "./serverTools.ts";

const advisory = {
  status: "behind_latest",
  currentVersion: "1.6.2",
  latestVersion: "1.6.3",
  updateCommand: "codegraph upgrade",
  canUpdate: true,
  checkedAt: "2026-11-02T00:00:00.000Z",
  message: null,
} as const;

const tool: ServerTool = {
  toolId: "codegraph",
  displayName: "CodeGraph",
  installed: true,
  version: "1.6.2",
  checkedAt: "2026-11-02T00:00:00.000Z",
  versionAdvisory: advisory,
};

describe("tools as update rows", () => {
  it("keys a tool by its id and carries its advisory and update state", () => {
    const row = toolAsProvider({
      ...tool,
      updateState: {
        status: "running",
        startedAt: null,
        finishedAt: null,
        message: null,
        output: null,
      },
    });
    expect(row.driver).toBe("codegraph");
    expect(row.instanceId).toBe("codegraph");
    expect(row.enabled).toBe(true);
    expect(row.versionAdvisory).toEqual(advisory);
    expect(row.updateState?.status).toBe("running");
    expect(row.models).toEqual([]);
  });

  it("is not an update candidate when it is not installed", () => {
    expect(toolAsProvider({ ...tool, installed: false }).enabled).toBe(false);
  });

  it("lists nothing for a server that does not report tools, so no call can reach it", () => {
    expect(toolsAsProviders(undefined)).toEqual([]);
    expect(updateSubjects({ providers: [] })).toEqual([]);
    expect(isToolId("codegraph")).toBe(true);
    expect(isToolId(ProviderDriverKind.make("codex"))).toBe(false);
  });

  it("appends tools after providers for the update surfaces only", () => {
    const providers = [toolAsProvider(tool)];
    const subjects = updateSubjects({ providers, tools: [tool] });
    expect(subjects.map((subject) => subject.driver)).toEqual(["codegraph", "codegraph"]);
    expect(updateSubjects({ providers, tools: [] })).toBe(providers);
  });
});
