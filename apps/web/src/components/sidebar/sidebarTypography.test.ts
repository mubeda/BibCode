// @effect-diagnostics nodeBuiltinImport:off - The guard reads left-panel source files to enforce UI.md typography.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { textSizesBelowTextXs } from "~/test/uiTypography";

// Every file that renders text in the left panel, except batch 1's environment
// context card and update badge. UI.md: nothing smaller than text-xs (12 px)
// and no letter-spacing utilities.
const LEFT_PANEL_SOURCES = [
  "../Sidebar.tsx",
  "../ThreadStatusIndicators.tsx",
  "../WorktreeAvailabilityWarning.tsx",
  "../WorktreeDiscoverySection.tsx",
  "./AgentsNavRow.tsx",
  "./EnvironmentRail.tsx",
  "./RelativeAge.tsx",
  "./SidebarProjectAvailability.tsx",
  "./SidebarProviderUpdatePill.tsx",
  "./SidebarUpdatePill.tsx",
  "./WorkspaceCard.tsx",
] as const;

const LETTER_SPACING = /\btracking-[\w.[\]-]+/g;

describe("left panel typography", () => {
  it("sets text-xs at every sidebar ProviderInstanceIcon usage, including imported initials", () => {
    const usages = LEFT_PANEL_SOURCES.flatMap((path) => {
      const source = NodeFS.readFileSync(new URL(path, import.meta.url), "utf8");
      return [...source.matchAll(/<ProviderInstanceIcon\b[\s\S]*?\/>/g)].map(([tag]) => tag);
    });
    expect(usages.length).toBeGreaterThan(0);
    for (const tag of usages) {
      expect(tag).toMatch(/iconClassName="[^"]*\btext-xs\b[^"]*"/);
      expect(tag).toContain("showBadge={false}");
    }
    // The shared component composes iconClassName after its default initials class.
    const icon = NodeFS.readFileSync(
      new URL("../chat/ProviderInstanceIcon.tsx", import.meta.url),
      "utf8",
    );
    expect(textSizesBelowTextXs(icon)).toEqual([]);
  });

  it("sets 6 px spacing in both project SidebarMenu branches", () => {
    const source = NodeFS.readFileSync(new URL("../Sidebar.tsx", import.meta.url), "utf8");
    const menus = [
      ...source.matchAll(/<SidebarMenu\b[^>]*data-testid="sidebar-project-list"[^>]*>/g),
    ];
    expect(menus).toHaveLength(2);
    for (const [tag] of menus) expect(tag).toContain('className="gap-1.5"');
    expect(menus.some(([tag]) => tag.includes("ref={attachProjectListAutoAnimateRef}"))).toBe(true);
  });

  it.each(LEFT_PANEL_SOURCES)("%s has no text below 12 px and no letter-spacing", (path) => {
    const source = NodeFS.readFileSync(new URL(path, import.meta.url), "utf8");
    expect(textSizesBelowTextXs(source)).toEqual([]);
    expect(source.match(LETTER_SPACING) ?? []).toEqual([]);
  });
});
