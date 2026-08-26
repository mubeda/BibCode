import { EnvironmentId, ProjectId } from "@bibcode/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentTreeProjectRow } from "../../environmentTree";
import { ProjectRow } from "./ProjectRow";

const row: EnvironmentTreeProjectRow = {
  kind: "project",
  key: "project:remote:api",
  parentKey: "environment:remote",
  environmentId: EnvironmentId.make("remote"),
  projectId: ProjectId.make("api"),
  workspaceRoot: "/srv/api",
  level: 2,
  label: "API",
  secondaryLabel: "/srv/api",
  activityLabel: "Running",
  isExpanded: false,
  isSelected: true,
  isCached: false,
  isStale: false,
  ariaPosInSet: 1,
  ariaSetSize: 4,
};

describe("ProjectRow", () => {
  it("keeps disclosure, selection, and project actions distinct", () => {
    const html = renderToStaticMarkup(
      <ProjectRow
        row={row}
        environmentLabel="Build host"
        focused={false}
        onFocus={vi.fn()}
        onKeyDown={vi.fn()}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(html).toContain('aria-label="Project API in environment Build host"');
    expect(html).toContain('aria-level="2"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Expand project API");
    expect(html).toContain("Open project API in Build host");
    expect(html).toContain("Project actions for API in Build host");
    expect(html).toContain("Running");
  });
});
