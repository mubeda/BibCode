import type { ServerTool } from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { toolRowView } from "./toolsSection.logic";

const base: ServerTool = {
  toolId: "codegraph",
  displayName: "CodeGraph",
  installed: true,
  version: "1.6.2",
  checkedAt: "2026-11-02T00:00:00.000Z",
};

const advisory = (
  overrides: Partial<NonNullable<ServerTool["versionAdvisory"]>>,
): NonNullable<ServerTool["versionAdvisory"]> => ({
  status: "unknown",
  currentVersion: "1.6.2",
  latestVersion: null,
  updateCommand: null,
  canUpdate: false,
  checkedAt: null,
  message: null,
  ...overrides,
});

describe("toolRowView", () => {
  it("offers the update when a newer version exists and BiBCode can install it", () => {
    const view = toolRowView({
      ...base,
      versionAdvisory: advisory({
        status: "behind_latest",
        latestVersion: "1.6.3",
        canUpdate: true,
        updateCommand: "codegraph upgrade",
      }),
    });
    expect(view.canUpdate).toBe(true);
    expect(view.description).toContain("Version 1.6.3 is available");
  });

  it("explains a disabled update instead of leaving the button dead", () => {
    const view = toolRowView({
      ...base,
      versionAdvisory: advisory({ status: "behind_latest", latestVersion: "1.6.3" }),
    });
    expect(view.canUpdate).toBe(false);
    expect(view.disabledReason).toContain("Update it with its own installer");
  });

  it("says so when it is current, not installed, or unknown with a reason", () => {
    expect(toolRowView({ ...base, versionAdvisory: advisory({ status: "current" }) }).tone).toBe(
      "success",
    );
    expect(toolRowView({ ...base, installed: false, version: null }).description).toContain(
      "Not installed",
    );
    const unknown = toolRowView({
      ...base,
      versionAdvisory: advisory({
        message: "BiBCode cannot tell how CodeGraph was installed, so it will not update it.",
      }),
    });
    expect(unknown.description).toContain("will not update it");
    expect(unknown.canUpdate).toBe(false);
  });

  it("shows progress and keeps running sessions in mind while an update runs", () => {
    const view = toolRowView({
      ...base,
      updateState: {
        status: "running",
        startedAt: null,
        finishedAt: null,
        message: "Updating tool.",
        output: null,
      },
    });
    expect(view.updating).toBe(true);
    expect(view.description).toContain("keep the old version until they restart");
  });

  it("keeps a failed update's message and still offers a reinstall when one exists", () => {
    const view = toolRowView({
      ...base,
      versionAdvisory: advisory({
        canUpdate: true,
        message: "CodeGraph may be damaged (the last update did not finish cleanly).",
      }),
      updateState: {
        status: "failed",
        startedAt: null,
        finishedAt: null,
        message: "Update command exited with code 1.",
        output: null,
      },
    });
    expect(view.tone).toBe("error");
    expect(view.description).toContain("exited with code 1");
    expect(view.description).toContain("may be damaged");
    expect(view.canUpdate).toBe(true);
  });
});
