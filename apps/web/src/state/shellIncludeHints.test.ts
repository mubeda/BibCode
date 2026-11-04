import { EnvironmentId, ThreadId } from "@bibcode/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../centerPanelStore", () => ({ useCenterPanelStore: { getState: () => ({}) } }));
vi.mock("../sidebarWorkspaceMetaStore", () => ({
  useSidebarWorkspaceMetaStore: { getState: () => ({}) },
}));

import { shellIncludeThreadIds } from "./shellIncludeHints";

describe("shellIncludeThreadIds (#223)", () => {
  it("names this environment's routed, panel-host, pinned and unread threads once each", () => {
    const environmentId = EnvironmentId.make("env-a");
    expect(
      shellIncludeThreadIds(environmentId, {
        routed: { environmentId, threadId: ThreadId.make("routed") },
        panelHostKeys: ["env-a:host", "env-b:other-host"],
        pinnedKeys: ["env-a:pinned", "env-a:routed"],
        unreadKeys: ["env-a:unread", "env-b:elsewhere"],
      }),
    ).toEqual(["routed", "host", "pinned", "unread"]);
  });
});
