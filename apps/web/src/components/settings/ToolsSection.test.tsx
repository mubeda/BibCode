import type { ServerTool } from "@bibcode/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  tools: undefined as ReadonlyArray<ServerTool> | undefined,
  update: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.tools }));
vi.mock("~/state/environments", () => ({
  usePrimaryEnvironment: () => ({ environmentId: "environment-primary" }),
}));
vi.mock("~/state/server", () => ({
  primaryServerToolsAtom: { key: "tools" },
  serverEnvironment: { updateProvider: { key: "updateProvider" } },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.update }));

import { ToolsSection } from "./ToolsSection";

const tool = (overrides: Partial<ServerTool>): ServerTool => ({
  toolId: "codegraph",
  displayName: "CodeGraph",
  installed: true,
  version: "1.6.2",
  checkedAt: "2026-11-02T00:00:00.000Z",
  ...overrides,
});

describe("ToolsSection", () => {
  beforeEach(() => {
    state.tools = undefined;
  });

  it("renders nothing for a server that reports no tools", () => {
    expect(renderToStaticMarkup(<ToolsSection />)).toBe("");
    state.tools = [];
    expect(renderToStaticMarkup(<ToolsSection />)).toBe("");
  });

  it("offers Update for an outdated tool it can update, and none when it cannot", () => {
    state.tools = [
      tool({
        versionAdvisory: {
          status: "behind_latest",
          currentVersion: "1.6.2",
          latestVersion: "1.6.3",
          updateCommand: "codegraph upgrade",
          canUpdate: true,
          checkedAt: null,
          message: null,
        },
      }),
    ];
    const outdated = renderToStaticMarkup(<ToolsSection />);
    expect(outdated).toContain("CodeGraph");
    expect(outdated).toContain("Version 1.6.3 is available");
    expect(outdated).toContain(">Update<");
    expect(outdated).toContain("Close agent sessions that use CodeGraph before updating");

    state.tools = [
      tool({
        versionAdvisory: {
          status: "unknown",
          currentVersion: "1.6.2",
          latestVersion: null,
          updateCommand: null,
          canUpdate: false,
          checkedAt: null,
          message: "BiBCode cannot tell how CodeGraph was installed, so it will not update it.",
        },
      }),
    ];
    const manual = renderToStaticMarkup(<ToolsSection />);
    expect(manual).toContain("will not update it");
    expect(manual).not.toContain(">Update<");
    expect(manual).not.toContain("Close agent sessions");
  });
});
