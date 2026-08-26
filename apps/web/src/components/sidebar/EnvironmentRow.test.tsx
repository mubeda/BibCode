import { EnvironmentId } from "@bibcode/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentTreeEnvironmentRow } from "../../environmentTree";
import { EnvironmentRow } from "./EnvironmentRow";

const row: EnvironmentTreeEnvironmentRow = {
  kind: "environment",
  key: "environment:remote",
  parentKey: null,
  environmentId: EnvironmentId.make("remote"),
  environmentKind: "remote",
  status: "reconnecting",
  statusText: "Reconnecting",
  canonicalLabel: "build-host.internal",
  lastSynchronizedAt: null,
  level: 1,
  label: "Build host",
  secondaryLabel: "build-host.internal",
  activityLabel: null,
  isExpanded: true,
  isSelected: false,
  isCached: true,
  isStale: true,
  ariaPosInSet: 2,
  ariaSetSize: 3,
};

describe("EnvironmentRow", () => {
  it("names status, alias, disclosure, and actions without reading external state", () => {
    const html = renderToStaticMarkup(
      <EnvironmentRow
        row={row}
        focused
        onFocus={vi.fn()}
        onKeyDown={vi.fn()}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );

    expect(html).toContain('role="treeitem"');
    expect(html).toContain('aria-label="Environment Build host, Reconnecting"');
    expect(html).toContain('aria-level="1"');
    expect(html).toContain('aria-posinset="2"');
    expect(html).toContain('aria-setsize="3"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("build-host.internal");
    expect(html).toContain("Collapse environment Build host");
    expect(html).toContain("Open environment Build host");
    expect(html).toContain("Environment actions for Build host");
  });
});
