import { EnvironmentId, ProjectId, ThreadId } from "@bibcode/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentTreeThreadRow } from "../../environmentTree";
import { ThreadRow } from "./ThreadRow";

function row(role: EnvironmentTreeThreadRow["role"]): EnvironmentTreeThreadRow {
  return {
    kind: "thread",
    key: `thread:remote:${role}`,
    parentKey: "project:remote:api",
    environmentId: EnvironmentId.make("remote"),
    projectId: ProjectId.make("api"),
    threadId: ThreadId.make(role),
    role,
    branch: role === "worktree" ? "feature/tree" : null,
    worktreePath: role === "worktree" ? "/srv/api-tree" : null,
    level: 3,
    label: role === "main" ? "Main" : "Improve navigation",
    secondaryLabel: role === "worktree" ? "feature/tree" : null,
    activityLabel: "Agent running",
    isExpanded: false,
    isSelected: role === "main",
    isCached: false,
    isStale: false,
    ariaPosInSet: 1,
    ariaSetSize: 3,
  };
}

describe("ThreadRow", () => {
  it.each([
    ["main", "Main thread"],
    ["ordinary", "Thread"],
    ["worktree", "Worktree thread"],
  ] as const)("announces the %s role and compact adornments", (role, label) => {
    const html = renderToStaticMarkup(
      <ThreadRow
        row={row(role)}
        environmentLabel="Build host"
        projectLabel="API"
        pinned
        unread
        focused={false}
        onFocus={vi.fn()}
        onKeyDown={vi.fn()}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(html).toContain(`${label} ${role === "main" ? "Main" : "Improve navigation"}`);
    expect(html).toContain("project API, environment Build host, Pinned, Unread, Agent running");
    expect(html).toContain('aria-level="3"');
    expect(html).not.toContain("aria-expanded");
    expect(html).toContain('aria-label="Unread"');
    expect(html).toContain('aria-label="Pinned"');
    if (role === "worktree") expect(html).toContain("feature/tree");
  });
});
